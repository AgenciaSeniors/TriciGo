-- ============================================================
-- 00679 — One owner per assisted ride, and the support number from the operator on shift
-- ============================================================
--
-- Design: docs/superpowers/specs/2026-11-07-support-ride-owner-design.md.
-- Plan: docs/superpowers/plans/2026-11-07-support-ride-owner.md.
-- Support is two operators (00667/00668). Today every alert pushes every ops staff account, anyone
-- can act on any ride, and the apps send riders to a hardcoded number. From here each ride that
-- needs support gets one owner among the staff on shift, and the apps ask the server for the number.
--
-- Staff and shifts:
--   support_staff               one row per staff member who used the switch: WhatsApp (E.164),
--                               on shift, missed rides in a row, last assignment
--   ride_assist.owner_*         who owns the ride, since when, when she opened it, who had it
--   ops_set_support_shift       the panel's "En turno" switch
--   ops_support_shift_status    what the switch shows
--   get_support_contact         the number riders and drivers write to (anon too)
--   _support_staff_on_shift     on shift, with a number, active, with an ops role
--   _support_pick_owner         who gets a ride: fewest open rides, then least recently assigned
--
-- Rules (spec, and 00668 / 00671-00673): SECURITY DEFINER, search_path set, EXECUTE revoked from
-- PUBLIC and anon; the panel's RPCs open to authenticated, get_support_contact to anon too, the
-- helpers to nobody. Refusals are {error} objects. Lock order: rides, then ride_assist, then
-- support_staff. No DELETE, DROP or TRUNCATE statements (an MCP apply waits for approval on them).
-- Re-applying the file changes nothing.

-- ── A. Settings ─────────────────────────────────────────────
-- Read with a floor where they are used: a ride passes to the next operator 60 s after it was
-- assigned (never under 30), and an operator goes off shift after 2 rides in a row she did not open
-- (never under 1).
INSERT INTO public.platform_config (key, value) VALUES
  ('support_handoff_after_s', '60'::jsonb),
  ('support_auto_offshift_misses', '2'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── B. Staff on shift ───────────────────────────────────────
-- Ops staff read every row (the panel shows who else is on shift). Nobody writes it directly: the
-- functions do.
CREATE TABLE IF NOT EXISTS public.support_staff (
  user_id          uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  whatsapp_phone   text CHECK (whatsapp_phone ~ '^\+[1-9][0-9]{7,14}$'),
  on_shift         boolean NOT NULL DEFAULT false,
  shift_started_at timestamptz,
  shift_ended_at   timestamptz,
  missed_in_a_row  integer NOT NULL DEFAULT 0,
  last_assigned_at timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.support_staff ENABLE ROW LEVEL SECURITY;
DO $policy$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'support_staff'
                   AND policyname = 'support_staff_select_ops') THEN
    CREATE POLICY support_staff_select_ops ON public.support_staff
      FOR SELECT TO authenticated USING ((SELECT public.is_ops_staff()));
  END IF;
END
$policy$;
REVOKE ALL ON public.support_staff FROM anon, authenticated;
GRANT SELECT ON public.support_staff TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_staff TO service_role;

-- ── C. Who owns a ride ──────────────────────────────────────
-- owner_id: the staff member who owns the ride. owner_assigned_at: since when. owner_opened_at: when
-- she opened its assist page. owners_tried: who had it, so a handover never returns it to them.
-- all_missed_alert_at: when every ops staff account was told nobody opened it. Deleting an account
-- lets go of its rides.
ALTER TABLE public.ride_assist
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS owner_assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS owner_opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS owners_tried uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS all_missed_alert_at timestamptz;
CREATE INDEX IF NOT EXISTS ride_assist_owner_id_idx ON public.ride_assist (owner_id) WHERE owner_id IS NOT NULL;

-- ── D. Shifts and the support contact ───────────────────────
-- Whether a staff member counts as on shift: the switch on, a number to give riders, an active
-- account with an ops role. An account blocked or demoted while the switch is on stops counting.
CREATE OR REPLACE FUNCTION public._support_staff_on_shift(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.support_staff s
    JOIN public.users u ON u.id = s.user_id
    WHERE s.user_id = p_user
      AND s.on_shift
      AND s.whatsapp_phone IS NOT NULL
      AND u.is_active
      AND u.role IN ('admin', 'super_admin', 'operator'));
$function$;

-- Who gets a ride: among the staff on shift, not in p_exclude and not the ride's rider or driver,
-- the one with the fewest open rides she owns (searching or active), then the one assigned least
-- recently (never first). Takes her turn: stamps last_assigned_at. NULL when nobody qualifies.
-- get_support_contact ranks the same way: keep the two ORDER BYs in step.
CREATE OR REPLACE FUNCTION public._support_pick_owner(p_ride_id uuid, p_exclude uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_rider  uuid;
  v_driver uuid;
  v_pick   uuid;
BEGIN
  SELECT r.customer_id, dp.user_id INTO v_rider, v_driver
  FROM public.rides r
  LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
  WHERE r.id = p_ride_id;

  -- Lock every row on shift, in one order, before ranking. A second pick waits here until the
  -- first commits, then ranks on a new snapshot that sees the first one's last_assigned_at, so two
  -- alerts at once go to two people. Locking only the chosen row would not do it: after the wait,
  -- Postgres rechecks that row's WHERE but not the ORDER BY, and both alerts get the same person.
  PERFORM 1 FROM public.support_staff WHERE on_shift ORDER BY user_id FOR UPDATE;

  SELECT s.user_id INTO v_pick
  FROM public.support_staff s
  WHERE public._support_staff_on_shift(s.user_id)
    AND array_position(COALESCE(p_exclude, '{}'::uuid[]), s.user_id) IS NULL
    AND s.user_id IS DISTINCT FROM v_rider
    AND s.user_id IS DISTINCT FROM v_driver
  ORDER BY (SELECT count(*) FROM public.ride_assist ra
            JOIN public.rides r ON r.id = ra.ride_id
            WHERE ra.owner_id = s.user_id
              AND r.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                               'in_progress', 'arrived_at_destination')),
           s.last_assigned_at NULLS FIRST,
           s.user_id
  LIMIT 1;

  IF v_pick IS NOT NULL THEN
    -- clock_timestamp(), not now(): several picks in one transaction (the cron tick) still take
    -- turns.
    UPDATE public.support_staff SET last_assigned_at = clock_timestamp(), updated_at = now()
    WHERE user_id = v_pick;
  END IF;
  RETURN v_pick;
END
$function$;

-- The number riders and drivers write to: someone on shift, in the order _support_pick_owner
-- assigns rides (without taking her turn); else the one whose shift ended last, if she is still
-- active staff; else none. Only the number, never the name.
CREATE OR REPLACE FUNCTION public.get_support_contact()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_phone text;
BEGIN
  SELECT s.whatsapp_phone INTO v_phone
  FROM public.support_staff s
  WHERE public._support_staff_on_shift(s.user_id)
  ORDER BY (SELECT count(*) FROM public.ride_assist ra
            JOIN public.rides r ON r.id = ra.ride_id
            WHERE ra.owner_id = s.user_id
              AND r.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                               'in_progress', 'arrived_at_destination')),
           s.last_assigned_at NULLS FIRST,
           s.user_id
  LIMIT 1;

  IF v_phone IS NULL THEN
    SELECT s.whatsapp_phone INTO v_phone
    FROM public.support_staff s
    JOIN public.users u ON u.id = s.user_id
    WHERE s.whatsapp_phone IS NOT NULL
      AND s.shift_ended_at IS NOT NULL
      AND u.is_active
      AND u.role IN ('admin', 'super_admin', 'operator')
    ORDER BY s.shift_ended_at DESC, s.user_id
    LIMIT 1;
  END IF;

  RETURN jsonb_build_object('phone', v_phone);
END
$function$;

-- The "En turno" switch. On needs a number in E.164 (the panel normalizes what she types): the one
-- given, else the one stored. It never falls back to users.phone, so an account phone in another
-- format never reaches riders unchecked. A number given while turning off is stored too. Turning on
-- resets the missed rides. Each change is logged (support_shift_on / support_shift_off).
CREATE OR REPLACE FUNCTION public.ops_set_support_shift(p_on boolean, p_whatsapp text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me     uuid := auth.uid();
  v_new    text := NULLIF(btrim(COALESCE(p_whatsapp, '')), '');
  v_old    public.support_staff%ROWTYPE;
  v_row    public.support_staff%ROWTYPE;
  v_handed integer := 0;
  v_kept   integer := 0;
BEGIN
  IF v_me IS NULL OR NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_on IS NULL THEN
    RETURN jsonb_build_object('error', 'invalid_request');
  END IF;
  IF v_new IS NOT NULL AND v_new !~ '^\+[1-9][0-9]{7,14}$' THEN
    RETURN jsonb_build_object('error', 'invalid_whatsapp');
  END IF;

  SELECT * INTO v_old FROM public.support_staff WHERE user_id = v_me FOR UPDATE;
  IF p_on AND COALESCE(v_new, v_old.whatsapp_phone) IS NULL THEN
    RETURN jsonb_build_object('error', 'whatsapp_required');
  END IF;

  INSERT INTO public.support_staff (user_id) VALUES (v_me) ON CONFLICT (user_id) DO NOTHING;
  UPDATE public.support_staff
     SET whatsapp_phone   = COALESCE(v_new, whatsapp_phone),
         on_shift         = p_on,
         shift_started_at = CASE WHEN p_on AND NOT on_shift THEN now() ELSE shift_started_at END,
         shift_ended_at   = CASE WHEN NOT p_on AND on_shift THEN now() ELSE shift_ended_at END,
         missed_in_a_row  = CASE WHEN p_on THEN 0 ELSE missed_in_a_row END,
         updated_at       = now()
   WHERE user_id = v_me
  RETURNING * INTO v_row;

  -- Her open rides: handed over when she goes off shift, picked up when she comes on (rules in the
  -- spec). v_handed and v_kept count them.

  IF COALESCE(v_old.on_shift, false) IS DISTINCT FROM v_row.on_shift
     OR v_old.whatsapp_phone IS DISTINCT FROM v_row.whatsapp_phone THEN
    INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
    VALUES (v_me, CASE WHEN p_on THEN 'support_shift_on' ELSE 'support_shift_off' END, 'support_staff', v_me::text,
            jsonb_build_object('on_shift', COALESCE(v_old.on_shift, false), 'whatsapp_phone', v_old.whatsapp_phone),
            jsonb_build_object('on_shift', v_row.on_shift, 'whatsapp_phone', v_row.whatsapp_phone,
                               'handed_over', v_handed, 'kept', v_kept));
  END IF;

  RETURN jsonb_build_object('success', true, 'on_shift', v_row.on_shift, 'whatsapp_phone', v_row.whatsapp_phone,
                            'handed_over', v_handed, 'kept', v_kept);
END
$function$;

-- What the switch shows: the caller's row (null before she first uses it), the others on shift
-- (only those who count: active, with a number), and her account phone to prefill the number.
CREATE OR REPLACE FUNCTION public.ops_support_shift_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL OR NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  RETURN jsonb_build_object(
    'me', (SELECT jsonb_build_object('on_shift', s.on_shift, 'whatsapp_phone', s.whatsapp_phone,
                                     'shift_started_at', s.shift_started_at, 'missed_in_a_row', s.missed_in_a_row)
           FROM public.support_staff s WHERE s.user_id = v_me),
    'on_shift', COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id', s.user_id, 'name', u.full_name)
                                           ORDER BY s.shift_started_at, s.user_id)
                          FROM public.support_staff s
                          JOIN public.users u ON u.id = s.user_id
                          WHERE s.user_id <> v_me AND public._support_staff_on_shift(s.user_id)),
                         '[]'::jsonb),
    'suggested_whatsapp', (SELECT u.phone FROM public.users u WHERE u.id = v_me));
END
$function$;

-- ── Permissions ─────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._support_staff_on_shift(uuid),
                       public._support_pick_owner(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ops_set_support_shift(boolean, text),
                       public.ops_support_shift_status(),
                       public.get_support_contact()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_set_support_shift(boolean, text),
                          public.ops_support_shift_status()
  TO authenticated, service_role;
-- The help screens ask for it before login too (the driver waiting for approval, the web).
GRANT EXECUTE ON FUNCTION public.get_support_contact() TO anon, authenticated, service_role;

-- Pasted from Windows, the SQL Editor puts carriage returns (chr(13)) inside the function bodies:
-- recreate them without those.
DO $crlf$
DECLARE
  v_fn regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._support_staff_on_shift(uuid)', 'public._support_pick_owner(uuid,uuid[])',
    'public.get_support_contact()', 'public.ops_set_support_shift(boolean,text)',
    'public.ops_support_shift_status()'
  ]::regprocedure[] LOOP
    SELECT pg_get_functiondef(v_fn) INTO v_def;
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- ── Checks ──────────────────────────────────────────────────
DO $check$
DECLARE
  v_row record;
BEGIN
  -- support_staff: RLS on, one read policy, written only by the functions (and service_role).
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.support_staff'::regclass)
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'support_staff') <> 1
     OR has_table_privilege('anon', 'public.support_staff', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.support_staff', 'SELECT')
     OR has_table_privilege('authenticated', 'public.support_staff', 'INSERT')
     OR has_table_privilege('authenticated', 'public.support_staff', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.support_staff', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.support_staff', 'UPDATE') THEN
    RAISE EXCEPTION '00679 check: support_staff is not locked down';
  END IF;

  -- Every function of this migration: SECURITY DEFINER, with its search_path.
  FOR v_row IN
    SELECT p.oid::regprocedure AS fn, p.prosecdef, p.proconfig FROM pg_proc p
    WHERE p.oid = ANY (ARRAY[
      'public._support_staff_on_shift(uuid)', 'public._support_pick_owner(uuid,uuid[])',
      'public.get_support_contact()', 'public.ops_set_support_shift(boolean,text)',
      'public.ops_support_shift_status()'
    ]::regprocedure[])
  LOOP
    IF NOT v_row.prosecdef OR v_row.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_catalog'] THEN
      RAISE EXCEPTION '00679 check: % is not SECURITY DEFINER with its search_path', v_row.fn;
    END IF;
  END LOOP;

  -- The helpers stay the owner's.
  IF has_function_privilege('anon', 'public._support_staff_on_shift(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._support_staff_on_shift(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._support_staff_on_shift(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._support_pick_owner(uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._support_pick_owner(uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._support_pick_owner(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION '00679 check: the helpers are open to clients';
  END IF;

  -- The panel's RPCs: authenticated, never anon. The contact: anon and authenticated.
  IF has_function_privilege('anon', 'public.ops_set_support_shift(boolean,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ops_support_shift_status()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.ops_set_support_shift(boolean,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.ops_support_shift_status()', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.get_support_contact()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_support_contact()', 'EXECUTE') THEN
    RAISE EXCEPTION '00679 check: the RPCs have the wrong grants';
  END IF;
END
$check$;
