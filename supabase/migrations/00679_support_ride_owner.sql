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
-- Owners and handover:
--   _support_alert (patched)    an alert gives the ride an owner on shift and pushes only her; with
--                               nobody to give it to, it pushes every ops staff account, as before
--   request_ride_help (patched) also returns support_phone, the number the rider writes to
--   _support_phone_for_ride     the owner's number while she is on shift, else the support contact
--   _support_send               one support push (the call _support_alert made before)
--   _support_alert_text         the title and body of a ride's support push
--   _support_handoff_rides_of   going off shift: her open rides pass to someone else on shift
--   _support_pickup_for         coming on shift: the rides waiting for an owner get one
--   support_handoff_tick        pg_cron, every 20 s: a ride not opened in time passes on; repeated
--                               misses take an operator off shift
--
-- Rules (spec, and 00668 / 00671-00673): SECURITY DEFINER, search_path set, EXECUTE revoked from
-- PUBLIC and anon; the panel's RPCs open to authenticated, get_support_contact to anon too, the
-- helpers to nobody. Refusals are {error} objects. Lock order: rides, then ride_assist, then the
-- support lock (an advisory lock, see _support_pick_owner), then support_staff rows. No DELETE, DROP
-- or TRUNCATE statements (an MCP apply waits for approval on them).
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
--
-- The support lock: pg_advisory_xact_lock(6790000000001), held until the transaction ends (the key
-- is above the int4 range, so it never meets a hashtext() key like 00209's). Every function that
-- locks or writes support_staff rows takes it first, before its first support_staff row: this one,
-- ops_set_support_shift, and the handover, pickup and cron tick that build on them. In the lock
-- order it sits after rides and ride_assist. With it, a second pick waits until the first commits,
-- then ranks on a new snapshot that sees the first one's last_assigned_at, so two alerts at once go
-- to two people; and no two transactions ever lock support_staff rows in different orders (a staff
-- member turning on between a pick's locks and its ranking deadlocked an earlier draft).
CREATE OR REPLACE FUNCTION public._support_pick_owner(p_ride_id uuid, p_exclude uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_support_lock CONSTANT bigint := 6790000000001;  -- the support lock (see the comment above)
  v_rider  uuid;
  v_driver uuid;
  v_pick   uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(c_support_lock);

  SELECT r.customer_id, dp.user_id INTO v_rider, v_driver
  FROM public.rides r
  LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
  WHERE r.id = p_ride_id;

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
-- Turning off hands her open rides over (_support_handoff_rides_of: handed_over, and kept for those
-- with nobody to take them); turning on picks up the rides waiting for someone (_support_pickup_for,
-- counted in handed_over). Both run under the support lock and her row, so they touch ride_assist
-- only with SKIP LOCKED (see section E).
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
  v_res    jsonb;
  v_handed integer := 0;
  v_kept   integer := 0;
  c_support_lock CONSTANT bigint := 6790000000001;  -- the support lock (see _support_pick_owner)
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

  -- Before her row: the refusals above touch no support_staff row, so they never wait for it.
  PERFORM pg_advisory_xact_lock(c_support_lock);
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

  -- Her open rides pass to someone else on shift when she goes off; the rides waiting for someone
  -- are picked up when she comes on.
  IF p_on THEN
    v_handed := public._support_pickup_for(v_me);
  ELSE
    v_res := public._support_handoff_rides_of(v_me);
    v_handed := (v_res ->> 'handed_over')::integer;
    v_kept := (v_res ->> 'kept')::integer;
  END IF;

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

-- ── E. Pushes and the rider's number ────────────────────────
-- Locks in part 2. Alerts (request_ride_help and the cron's wait alert, through _support_alert)
-- read the ride, hold its ride_assist row, then wait for the support lock in _support_pick_owner:
-- the order rides, ride_assist, support lock, support_staff. The handover and the pickup run inside
-- ops_set_support_shift, which already holds the lock and her row, and the tick's off-shift step
-- holds staff rows: those take ride_assist rows only with FOR UPDATE SKIP LOCKED and never lock
-- rides, so they never wait for an alert that waits for them. A ride skipped this way stays as it
-- was: one the tick skipped is due again at the next tick; one the handover skipped stays with its
-- owner (now off shift) until a pickup or its next alert gives it to someone on shift. The tick
-- takes its rows the same way, before any pick.

-- The title and body of a ride's support push, as _support_alert wrote them before 00679: the other
-- pushes prefix the title ("Te toca · ", "Te pasamos un viaje · ", "Nadie abrió el viaje · ").
CREATE OR REPLACE FUNCTION public._support_alert_text(p_ride_id uuid, p_kind text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT jsonb_build_object(
    'title', CASE WHEN p_kind = 'help' THEN 'Pasajero pide ayuda · ' ELSE 'Viaje sin conductor · ' END
             || public._ride_type_label(r.service_type, r.ride_mode) || ' · ' || public._ride_short_code(r.id),
    'body', 'Espera ' || GREATEST(0, floor(extract(epoch FROM now() - GREATEST(r.created_at, r.scheduled_at)) / 60))::int
            || ' min · ' || left(COALESCE(r.pickup_address, '—'), 60) || ' → ' || left(COALESCE(r.dropoff_address, '—'), 60))
  FROM public.rides r
  WHERE r.id = p_ride_id;
$function$;

-- A support push through send-push: the call _support_alert made before 00679, with the same
-- handling. With no service role key, or when the call fails, it warns and logs alert_failed, and
-- its caller goes on: an assignment or a handover stays even if its push does not go out. A push
-- with no ride (the automatic off-shift) carries no ride_id or link.
CREATE OR REPLACE FUNCTION public._support_send(p_label text, p_user_ids uuid[], p_title text, p_body text,
                                                p_event text, p_ride_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_key  text;
  v_data jsonb := jsonb_build_object('event', p_event);
BEGIN
  IF COALESCE(cardinality(p_user_ids), 0) = 0 THEN
    RETURN;
  END IF;
  IF p_ride_id IS NOT NULL THEN
    v_data := v_data || jsonb_build_object('ride_id', p_ride_id::text,
                                           'url', 'https://admin.tricigo.com/rides/' || p_ride_id::text || '/assist');
  END IF;

  v_key := public.get_service_role_key();
  IF v_key IS NULL OR v_key = '' THEN
    RAISE WARNING '_support_send: no service role key, the % push for ride % was not sent', p_label, p_ride_id;
    PERFORM public.log_rpc_attempt('_support_alert', auth.uid(), p_ride_id, 'alert_failed',
      jsonb_build_object('label', p_label, 'event', p_event, 'error', 'no service role key'));
    RETURN;
  END IF;

  PERFORM public.cron_http_post(
    p_label,
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
    body    := jsonb_build_object(
      'user_ids', to_jsonb(p_user_ids),
      'title', p_title, 'body', p_body, 'category', 'system',
      'data', v_data));
EXCEPTION WHEN OTHERS THEN
  -- A push never fails its caller (the rider's button, the cron, the switch).
  RAISE WARNING '_support_send failed for ride %: % %', p_ride_id, SQLSTATE, SQLERRM;
  PERFORM public.log_rpc_attempt('_support_alert', auth.uid(), p_ride_id, 'alert_failed',
    jsonb_build_object('label', p_label, 'event', p_event, 'error', SQLERRM));
END
$function$;

-- The number the rider of this ride writes to: its owner's while she is on shift; else the support
-- contact (someone on shift, else the last one), also for an owner who went off shift.
CREATE OR REPLACE FUNCTION public._support_phone_for_ride(p_ride_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_phone text;
BEGIN
  SELECT s.whatsapp_phone INTO v_phone
  FROM public.ride_assist ra
  JOIN public.support_staff s ON s.user_id = ra.owner_id
  WHERE ra.ride_id = p_ride_id
    AND public._support_staff_on_shift(ra.owner_id);
  RETURN COALESCE(v_phone, public.get_support_contact() ->> 'phone');
END
$function$;

-- ── F. Handover, pickup and the tick ────────────────────────
-- Her open rides (searching or active) pass to someone else on shift by the assignment rule, never
-- back to someone who had them, each with a push; those nobody can take stay hers. Returns
-- {handed_over, kept}: kept counts every open ride still hers, a ride skipped as locked included.
CREATE OR REPLACE FUNCTION public._support_handoff_rides_of(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_support_lock CONSTANT bigint := 6790000000001;  -- the support lock (see _support_pick_owner)
  v_ids    uuid[];
  v_id     uuid;
  v_ra     public.ride_assist%ROWTYPE;
  v_new    uuid;
  v_text   jsonb;
  v_handed integer := 0;
  v_kept   integer;
BEGIN
  -- SKIP LOCKED: the callers hold the support lock (section E).
  v_ids := ARRAY(
    SELECT ra.ride_id
    FROM public.ride_assist ra
    JOIN public.rides r ON r.id = ra.ride_id
    WHERE ra.owner_id = p_user
      AND r.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                       'in_progress', 'arrived_at_destination')
    ORDER BY ra.owner_assigned_at NULLS FIRST, ra.ride_id
    FOR UPDATE OF ra SKIP LOCKED);

  PERFORM pg_advisory_xact_lock(c_support_lock);
  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT * INTO v_ra FROM public.ride_assist WHERE ride_id = v_id;
    v_new := public._support_pick_owner(v_id, v_ra.owners_tried || p_user);
    IF v_new IS NOT NULL THEN
      UPDATE public.ride_assist
         SET owner_id = v_new, owner_assigned_at = now(), owner_opened_at = NULL,
             all_missed_alert_at = NULL, owners_tried = owners_tried || v_new
       WHERE ride_id = v_id;
      v_text := public._support_alert_text(v_id, CASE WHEN v_ra.help_alert_sent_at IS NOT NULL THEN 'help' ELSE 'wait' END);
      PERFORM public._support_send('support-handoff', ARRAY[v_new], 'Te pasamos un viaje · ' || (v_text ->> 'title'),
                                   v_text ->> 'body', 'support_handoff', v_id);
      v_handed := v_handed + 1;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_kept
  FROM public.ride_assist ra
  JOIN public.rides r ON r.id = ra.ride_id
  WHERE ra.owner_id = p_user
    AND r.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                     'in_progress', 'arrived_at_destination');
  RETURN jsonb_build_object('handed_over', v_handed, 'kept', v_kept);
END
$function$;

-- When p_user comes on shift: every searching ride already alerted that has no owner, or whose owner
-- is off shift and never opened it, gets an owner by the assignment rule (her, or someone on shift
-- with fewer open rides), with a push. A ride its owner opened stays hers: she may be on it by
-- WhatsApp. Returns how many were assigned.
CREATE OR REPLACE FUNCTION public._support_pickup_for(p_user uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_support_lock CONSTANT bigint := 6790000000001;  -- the support lock (see _support_pick_owner)
  v_ids  uuid[];
  v_id   uuid;
  v_ra   public.ride_assist%ROWTYPE;
  v_new  uuid;
  v_text jsonb;
  v_n    integer := 0;
BEGIN
  IF NOT public._support_staff_on_shift(p_user) THEN
    RETURN 0;
  END IF;

  -- SKIP LOCKED: the caller holds the support lock (section E).
  v_ids := ARRAY(
    SELECT ra.ride_id
    FROM public.ride_assist ra
    JOIN public.rides r ON r.id = ra.ride_id
    WHERE r.status = 'searching'
      AND (ra.help_alert_sent_at IS NOT NULL OR ra.wait_alert_sent_at IS NOT NULL)
      AND (ra.owner_id IS NULL
           OR (ra.owner_opened_at IS NULL AND NOT public._support_staff_on_shift(ra.owner_id)))
    ORDER BY (ra.help_alert_sent_at IS NULL), GREATEST(r.created_at, r.scheduled_at), ra.ride_id
    FOR UPDATE OF ra SKIP LOCKED);

  PERFORM pg_advisory_xact_lock(c_support_lock);
  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT * INTO v_ra FROM public.ride_assist WHERE ride_id = v_id;
    v_new := public._support_pick_owner(v_id, v_ra.owners_tried);
    IF v_new IS NOT NULL THEN
      UPDATE public.ride_assist
         SET owner_id = v_new, owner_assigned_at = now(), owner_opened_at = NULL,
             all_missed_alert_at = NULL, owners_tried = owners_tried || v_new
       WHERE ride_id = v_id;
      v_text := public._support_alert_text(v_id, CASE WHEN v_ra.help_alert_sent_at IS NOT NULL THEN 'help' ELSE 'wait' END);
      PERFORM public._support_send('support-owner-alert', ARRAY[v_new], 'Te toca · ' || (v_text ->> 'title'),
                                   v_text ->> 'body', 'support_owner', v_id);
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END
$function$;

-- The cron tick (every 20 s). 1. A searching ride whose owner on shift has not opened it
-- support_handoff_after_s (floor 30) after it was assigned passes to someone on shift who has not
-- had it, with a push; with nobody, it stays hers and every ops staff account gets one push for it
-- (all_missed_alert_at). Either way her miss counter goes up, once per assignment: the ride then has
-- a new assignment or the all-missed mark, and neither comes back here. 2. Whoever reaches
-- support_auto_offshift_misses (floor 1) misses goes off shift, with a push, and her open rides are
-- handed over. Returns how many rides step 1 handled.
CREATE OR REPLACE FUNCTION public.support_handoff_tick()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_support_lock CONSTANT bigint := 6790000000001;  -- the support lock (see _support_pick_owner)
  v_after  integer := GREATEST(30, public.get_platform_config_numeric('support_handoff_after_s', 60)::int);
  v_misses integer := GREATEST(1, public.get_platform_config_numeric('support_auto_offshift_misses', 2)::int);
  v_ids    uuid[];
  v_id     uuid;
  v_ra     public.ride_assist%ROWTYPE;
  v_new    uuid;
  v_text   jsonb;
  v_all    uuid[];
  v_staff  public.support_staff%ROWTYPE;
  v_res    jsonb;
  v_n      integer := 0;
BEGIN
  -- The rides due, locked before any pick; a row another transaction holds waits for the next tick.
  v_ids := ARRAY(
    SELECT ra.ride_id
    FROM public.ride_assist ra
    JOIN public.rides r ON r.id = ra.ride_id
    WHERE ra.owner_id IS NOT NULL
      AND ra.owner_opened_at IS NULL
      AND ra.all_missed_alert_at IS NULL
      AND ra.owner_assigned_at <= now() - make_interval(secs => v_after)
      AND r.status = 'searching'
      AND public._support_staff_on_shift(ra.owner_id)
    ORDER BY ra.owner_assigned_at, ra.ride_id
    FOR UPDATE OF ra SKIP LOCKED);

  PERFORM pg_advisory_xact_lock(c_support_lock);
  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT * INTO v_ra FROM public.ride_assist WHERE ride_id = v_id;
    v_text := public._support_alert_text(v_id, CASE WHEN v_ra.help_alert_sent_at IS NOT NULL THEN 'help' ELSE 'wait' END);
    UPDATE public.support_staff SET missed_in_a_row = missed_in_a_row + 1, updated_at = now()
     WHERE user_id = v_ra.owner_id;
    v_new := public._support_pick_owner(v_id, v_ra.owners_tried || v_ra.owner_id);
    IF v_new IS NOT NULL THEN
      UPDATE public.ride_assist
         SET owner_id = v_new, owner_assigned_at = now(), owner_opened_at = NULL,
             all_missed_alert_at = NULL, owners_tried = owners_tried || v_new
       WHERE ride_id = v_id;
      PERFORM public._support_send('support-handoff', ARRAY[v_new], 'Te pasamos un viaje · ' || (v_text ->> 'title'),
                                   v_text ->> 'body', 'support_handoff', v_id);
    ELSE
      UPDATE public.ride_assist SET all_missed_alert_at = now() WHERE ride_id = v_id;
      SELECT array_agg(u.id) INTO v_all
      FROM public.users u
      WHERE u.role IN ('admin', 'super_admin', 'operator') AND u.is_active;
      PERFORM public._support_send('support-all-missed', v_all, 'Nadie abrió el viaje · ' || (v_text ->> 'title'),
                                   v_text ->> 'body', 'support_all_missed', v_id);
    END IF;
    v_n := v_n + 1;
  END LOOP;

  FOR v_staff IN
    SELECT * FROM public.support_staff
    WHERE on_shift AND missed_in_a_row >= v_misses
    ORDER BY user_id
    FOR UPDATE
  LOOP
    UPDATE public.support_staff SET on_shift = false, shift_ended_at = now(), updated_at = now()
     WHERE user_id = v_staff.user_id;
    v_res := public._support_handoff_rides_of(v_staff.user_id);
    -- Nobody acted, and admin_id must be a user: the row names her.
    INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
    VALUES (v_staff.user_id, 'support_shift_auto_off', 'support_staff', v_staff.user_id::text,
            jsonb_build_object('on_shift', true, 'missed_in_a_row', v_staff.missed_in_a_row),
            jsonb_build_object('on_shift', false, 'handed_over', v_res -> 'handed_over', 'kept', v_res -> 'kept'));
    PERFORM public._support_send('support-auto-offshift', ARRAY[v_staff.user_id], 'Te sacamos de turno',
      'No abriste ' || v_misses || ' viajes seguidos. Actívalo de nuevo cuando puedas.', 'support_offshift', NULL);
  END LOOP;

  RETURN v_n;
END
$function$;

-- ── G. Patches of live bodies ───────────────────────────────
-- Each body is replaced only from its md5 in prod on 2026-11-07, each replaced text must appear
-- exactly once, and re-applying changes nothing (00673's helper).
CREATE OR REPLACE FUNCTION pg_temp.m00679_patch(p_fn regprocedure, p_old_md5 text, p_new_md5 text,
                                               p_olds text[], p_news text[])
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_md5 text;
  v_def text;
  i integer;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = p_fn;
  IF v_md5 = p_new_md5 THEN
    RETURN;
  END IF;
  IF v_md5 IS DISTINCT FROM p_old_md5 THEN
    RAISE EXCEPTION '00679: % has an unknown body (md5 %)', p_fn, v_md5;
  END IF;
  SELECT pg_get_functiondef(p_fn) INTO v_def;
  FOR i IN 1 .. array_length(p_olds, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_olds[i], ''))) / length(p_olds[i]) <> 1 THEN
      RAISE EXCEPTION '00679: % does not have text % exactly once', p_fn, i;
    END IF;
    v_def := replace(v_def, p_olds[i], p_news[i]);
  END LOOP;
  EXECUTE v_def;
END
$function$;

-- _support_alert: the whole body (the md5 pins it to prod's, 00632's). The ride gets its owner, and
-- only she is pushed; with nobody to give it to, everyone is, as before. The texts are pasted with
-- their line ends stripped of chr(13), so a copy pasted from Windows patches the same.
SELECT pg_temp.m00679_patch('public._support_alert(uuid,text)', '992c2ce11b664d72e437a683170abb97',
  '2e0ae1a5219e5e3ec8772124f1b50767',
  ARRAY[(SELECT prosrc FROM pg_proc WHERE oid = 'public._support_alert(uuid,text)'::regprocedure)],
  ARRAY[replace($new$
DECLARE
  v_ride   public.rides%ROWTYPE;
  v_ra     public.ride_assist%ROWTYPE;
  v_owner  uuid;
  v_admins uuid[];
  v_text   jsonb;
BEGIN
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_text := public._support_alert_text(p_ride_id, p_kind);

  -- 00679: one owner on shift. An owner on shift keeps the ride. With no owner, or one off shift,
  -- the assignment rule picks someone on shift who has not had it. With nobody to pick, an owner
  -- off shift stays its owner (the panel shows her) and everyone is told, as when nobody is on
  -- shift. The caller (request_ride_help, the cron) already holds the ride_assist row.
  SELECT * INTO v_ra FROM public.ride_assist WHERE ride_id = p_ride_id FOR UPDATE;
  IF FOUND THEN
    IF v_ra.owner_id IS NOT NULL AND public._support_staff_on_shift(v_ra.owner_id) THEN
      v_owner := v_ra.owner_id;
    ELSE
      v_owner := public._support_pick_owner(p_ride_id, v_ra.owners_tried);
      IF v_owner IS NOT NULL THEN
        UPDATE public.ride_assist
           SET owner_id = v_owner, owner_assigned_at = now(), owner_opened_at = NULL,
               all_missed_alert_at = NULL, owners_tried = owners_tried || v_owner
         WHERE ride_id = p_ride_id;
      END IF;
    END IF;
  END IF;

  IF v_owner IS NOT NULL THEN
    PERFORM public._support_send('support-owner-alert', ARRAY[v_owner], 'Te toca · ' || (v_text ->> 'title'),
                                 v_text ->> 'body', 'support_owner', p_ride_id);
  ELSE
    SELECT array_agg(u.id) INTO v_admins
    FROM public.users u
    WHERE u.role IN ('admin', 'super_admin', 'operator') AND u.is_active;
    PERFORM public._support_send(CASE WHEN p_kind = 'help' THEN 'support-help-alert' ELSE 'support-wait-alert' END,
                                 v_admins, v_text ->> 'title', v_text ->> 'body', 'support_' || p_kind, p_ride_id);
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- An alert never fails its caller (the rider's button, the cron).
  RAISE WARNING '_support_alert failed for ride %: % %', p_ride_id, SQLSTATE, SQLERRM;
  PERFORM public.log_rpc_attempt('_support_alert', auth.uid(), p_ride_id, 'alert_failed',
    jsonb_build_object('kind', p_kind, 'error', SQLERRM));
END;
$new$, chr(13), '')]);

-- request_ride_help: the answer gains support_phone, also when the help alert is capped.
SELECT pg_temp.m00679_patch('public.request_ride_help(uuid)', '0568a44a41e6b9ef925ae1b2b2799cb1',
  '2b9faf1390909d63ae02696105d78090',
  ARRAY[E'  RETURN jsonb_build_object(''success'', true, ''code'', public._ride_short_code(p_ride_id));'],
  ARRAY[E'  -- 00679: the number the rider writes to (the owner on shift, else the support contact).\n'
        || E'  RETURN jsonb_build_object(''success'', true, ''code'', public._ride_short_code(p_ride_id),\n'
        || E'                            ''support_phone'', public._support_phone_for_ride(p_ride_id));']);

-- ── H. The handover tick in pg_cron ─────────────────────────
-- Every 20 s (pg_cron 1.6.4 takes seconds): a ride passes 60 to 80 s after it was assigned.
-- cron.schedule updates a job of the same name.
SELECT cron.schedule('support-handoff-tick', '20 seconds', 'SELECT public.support_handoff_tick()');

-- ── Permissions ─────────────────────────────────────────────
-- The helpers and the tick (pg_cron runs it as the owner) to nobody.
REVOKE ALL ON FUNCTION public._support_staff_on_shift(uuid),
                       public._support_pick_owner(uuid, uuid[]),
                       public._support_alert_text(uuid, text),
                       public._support_send(text, uuid[], text, text, text, uuid),
                       public._support_phone_for_ride(uuid),
                       public._support_handoff_rides_of(uuid),
                       public._support_pickup_for(uuid),
                       public.support_handoff_tick()
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
    'public.ops_support_shift_status()', 'public._support_alert_text(uuid,text)',
    'public._support_send(text,uuid[],text,text,text,uuid)', 'public._support_phone_for_ride(uuid)',
    'public._support_handoff_rides_of(uuid)', 'public._support_pickup_for(uuid)',
    'public.support_handoff_tick()'
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

  -- Every function of this migration, and the two it patches: SECURITY DEFINER, with its search_path.
  FOR v_row IN
    SELECT p.oid::regprocedure AS fn, p.prosecdef, p.proconfig FROM pg_proc p
    WHERE p.oid = ANY (ARRAY[
      'public._support_staff_on_shift(uuid)', 'public._support_pick_owner(uuid,uuid[])',
      'public.get_support_contact()', 'public.ops_set_support_shift(boolean,text)',
      'public.ops_support_shift_status()', 'public._support_alert_text(uuid,text)',
      'public._support_send(text,uuid[],text,text,text,uuid)', 'public._support_phone_for_ride(uuid)',
      'public._support_handoff_rides_of(uuid)', 'public._support_pickup_for(uuid)',
      'public.support_handoff_tick()', 'public._support_alert(uuid,text)', 'public.request_ride_help(uuid)'
    ]::regprocedure[])
  LOOP
    IF NOT v_row.prosecdef OR v_row.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_catalog'] THEN
      RAISE EXCEPTION '00679 check: % is not SECURITY DEFINER with its search_path', v_row.fn;
    END IF;
  END LOOP;

  -- The helpers and the tick stay the owner's.
  FOR v_row IN
    SELECT f.fn FROM unnest(ARRAY[
      'public._support_staff_on_shift(uuid)', 'public._support_pick_owner(uuid,uuid[])',
      'public._support_alert_text(uuid,text)', 'public._support_send(text,uuid[],text,text,text,uuid)',
      'public._support_phone_for_ride(uuid)', 'public._support_handoff_rides_of(uuid)',
      'public._support_pickup_for(uuid)', 'public.support_handoff_tick()'
    ]::regprocedure[]) AS f(fn)
  LOOP
    IF has_function_privilege('anon', v_row.fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_row.fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_row.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00679 check: the helpers are open to clients (%)', v_row.fn;
    END IF;
  END LOOP;

  -- The two patched bodies: the 00679 ones, with prod's grants (the alert closed to clients, the
  -- help button open to signed-in riders).
  FOR v_row IN
    SELECT f.fn, f.want, md5(p.prosrc) AS got
    FROM (VALUES
      ('public._support_alert(uuid,text)'::regprocedure, '2e0ae1a5219e5e3ec8772124f1b50767'),
      ('public.request_ride_help(uuid)', '2b9faf1390909d63ae02696105d78090')
    ) AS f(fn, want)
    JOIN pg_proc p ON p.oid = f.fn
  LOOP
    IF v_row.got IS DISTINCT FROM v_row.want THEN
      RAISE EXCEPTION '00679 check: % has md5 %, expected %', v_row.fn, v_row.got, v_row.want;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public._support_alert(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._support_alert(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.request_ride_help(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.request_ride_help(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00679 check: the patched functions have the wrong grants';
  END IF;

  -- The handover tick is scheduled.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'support-handoff-tick' AND schedule = '20 seconds'
                   AND command = 'SELECT public.support_handoff_tick()') THEN
    RAISE EXCEPTION '00679 check: the support-handoff-tick job is missing';
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
