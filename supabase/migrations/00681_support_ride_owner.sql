-- ============================================================
-- 00681 — One owner per assisted ride, and the support number from the operator on shift
-- ============================================================
--
-- Design: docs/superpowers/specs/2026-11-07-support-ride-owner-design.md.
-- Plan: docs/superpowers/plans/2026-11-07-support-ride-owner.md.
-- Written as 00679 and renumbered to 00681 on 2026-11-14: Moto Deportiva (#1196) took 00679 and
-- 00680 first. The advisory lock key 6790000000001 (section D) keeps its value.
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
--   notify_support_waiting_rides (patched)  the cron's wait alerts go out after every row it writes
--   _support_ride_open          what an open ride is: searching, or active with its assist page opened
--   _support_phone_for_ride     the owner's number while she is on shift, else the support contact
--   _support_send               one support push (the call _support_alert made before)
--   _support_alert_text         the title and body of a ride's support push
--   _support_handoff_rides_of   going off shift: her open rides pass to someone else on shift
--   _support_pickup_for         coming on shift: the rides waiting for an owner get one
--   support_handoff_tick        pg_cron, every 20 s: a ride not opened in time passes on; repeated
--                               misses take an operator off shift
--
-- The assist actions and the panel:
--   _assist_claim_or_refuse     the ownership guard: a ride with no owner becomes the caller's;
--                               one someone else owns refuses (ride_owned_by_other)
--   the seven assist actions (patched)  offer, assign and change type (00628), release, advance and
--                               complete (00660), and admin_cancel_ride call the guard first
--   ops_open_ride_assist        the assist page loads: its owner's opening stops the handover
--   ops_take_ride_assist        "Tomar este viaje": the caller becomes the owner
--   _support_ride_owner         who owns a ride, for the two contexts
--   admin_ride_assist_context, admin_active_ride_context (patched)  gain the owner key
--   admin_support_waiting_rides_v2  the banner, with the owner (v1 stays as it was)
--
-- Rules (spec, and 00668 / 00671-00673): SECURITY DEFINER, search_path set, EXECUTE revoked from
-- PUBLIC and anon; the panel's RPCs open to authenticated, get_support_contact to anon too, the
-- helpers to nobody. Refusals are {error} objects. Lock order: rides, then ride_assist, then the
-- support lock (an advisory lock, see _support_pick_owner), then support_staff rows. No DELETE, DROP
-- or TRUNCATE statements (an MCP apply waits for approval on them): the banner's new columns come
-- in a new function, admin_support_waiting_rides_v2, not in a changed signature.
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

-- Whether a ride its owner has is open (the spec's "open"): still searching, or active (a driver
-- took it) with its assist page opened by the owner. A closed ride (completed, canceled, disputed)
-- never is. The one definition of an open ride: the pick's load, the support contact's order, and
-- the handover (which rides pass on, and kept) all use it.
CREATE OR REPLACE FUNCTION public._support_ride_open(p_status public.ride_status, p_owner_opened_at timestamptz)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT p_status = 'searching'
      OR (p_status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination')
          AND p_owner_opened_at IS NOT NULL);
$function$;

-- Who gets a ride: among the staff on shift, not in p_exclude and not the ride's rider or driver,
-- the one with the fewest open rides she owns (_support_ride_open), then the one assigned least
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
              AND public._support_ride_open(r.status, ra.owner_opened_at)),
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
              AND public._support_ride_open(r.status, ra.owner_opened_at)),
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
-- format never reaches riders unchecked. A number given while turning off is stored too.
-- Only a transition does more than store the number. Going off (on to off) hands her open rides
-- over (_support_handoff_rides_of: handed_over, and kept for those with nobody to take them); coming
-- on (off to on) resets the missed rides and picks up the rides waiting for someone
-- (_support_pickup_for: picked_up). Both run under the support lock and her row, so they touch
-- ride_assist only with SKIP LOCKED (see section E). A call that keeps the state (the panel's
-- "Cambiar número") only stores the number and answers 0, 0, 0. Logged: support_shift_on /
-- support_shift_off for a transition, support_shift_number for a number change alone, nothing when
-- neither changed.
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
  v_picked integer := 0;
  v_was    boolean;
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
  v_was := COALESCE(v_old.on_shift, false);

  INSERT INTO public.support_staff (user_id) VALUES (v_me) ON CONFLICT (user_id) DO NOTHING;
  UPDATE public.support_staff
     SET whatsapp_phone   = COALESCE(v_new, whatsapp_phone),
         on_shift         = p_on,
         shift_started_at = CASE WHEN p_on AND NOT on_shift THEN now() ELSE shift_started_at END,
         shift_ended_at   = CASE WHEN NOT p_on AND on_shift THEN now() ELSE shift_ended_at END,
         missed_in_a_row  = CASE WHEN p_on AND NOT on_shift THEN 0 ELSE missed_in_a_row END,
         updated_at       = now()
   WHERE user_id = v_me
  RETURNING * INTO v_row;

  -- Only a transition: her open rides pass to someone else on shift when she goes off; the rides
  -- waiting for someone are picked up when she comes on. A call that keeps the state does neither.
  IF p_on AND NOT v_was THEN
    v_picked := public._support_pickup_for(v_me);
  ELSIF NOT p_on AND v_was THEN
    v_res := public._support_handoff_rides_of(v_me);
    v_handed := (v_res ->> 'handed_over')::integer;
    v_kept := (v_res ->> 'kept')::integer;
  END IF;

  IF v_was IS DISTINCT FROM v_row.on_shift
     OR v_old.whatsapp_phone IS DISTINCT FROM v_row.whatsapp_phone THEN
    INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
    VALUES (v_me, CASE WHEN v_was = v_row.on_shift THEN 'support_shift_number'
                       WHEN p_on THEN 'support_shift_on' ELSE 'support_shift_off' END,
            'support_staff', v_me::text,
            jsonb_build_object('on_shift', v_was, 'whatsapp_phone', v_old.whatsapp_phone),
            jsonb_build_object('on_shift', v_row.on_shift, 'whatsapp_phone', v_row.whatsapp_phone,
                               'handed_over', v_handed, 'kept', v_kept, 'picked_up', v_picked));
  END IF;

  RETURN jsonb_build_object('success', true, 'on_shift', v_row.on_shift, 'whatsapp_phone', v_row.whatsapp_phone,
                            'handed_over', v_handed, 'kept', v_kept, 'picked_up', v_picked);
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
-- the order rides, ride_assist, support lock, support_staff. The cron writes all of its ride_assist
-- rows before its first alert (section G), so it never waits for a row while it holds the lock. The handover and the pickup run inside
-- ops_set_support_shift, which already holds the lock and her row, and the tick's off-shift step
-- holds staff rows: those take ride_assist rows only with FOR UPDATE SKIP LOCKED and never lock
-- rides, so they never wait for an alert that waits for them. A ride skipped this way stays as it
-- was: one the tick skipped is due again at the next tick; one the handover skipped stays with its
-- owner (now off shift) until a pickup or its next alert gives it to someone on shift. The tick
-- takes its rows the same way, before any pick.

-- The title and body of a ride's support push, as _support_alert wrote them before 00681: the other
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

-- A support push through send-push: the call _support_alert made before 00681, with the same
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
-- Her open rides (_support_ride_open: searching, or active and opened) pass to someone else on
-- shift by the assignment rule, never back to someone who had them, each with a push; those nobody
-- can take stay hers. An active ride she never opened is not hers to hand over: it stays, uncounted.
-- Returns {handed_over, kept}: kept counts every open ride still hers, a ride skipped as locked
-- included.
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
  v_ride   public.rides%ROWTYPE;
  v_new    uuid;
  v_text   jsonb;
  v_title  text;
  v_body   text;
  v_handed integer := 0;
  v_kept   integer;
BEGIN
  -- SKIP LOCKED: the callers hold the support lock (section E).
  v_ids := ARRAY(
    SELECT ra.ride_id
    FROM public.ride_assist ra
    JOIN public.rides r ON r.id = ra.ride_id
    WHERE ra.owner_id = p_user
      AND public._support_ride_open(r.status, ra.owner_opened_at)
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
      SELECT * INTO v_ride FROM public.rides WHERE id = v_id;
      IF v_ride.status = 'searching' THEN
        v_text := public._support_alert_text(v_id, CASE WHEN v_ra.help_alert_sent_at IS NOT NULL THEN 'help' ELSE 'wait' END);
        v_title := 'Te pasamos un viaje · ' || (v_text ->> 'title');
        v_body := v_text ->> 'body';
      ELSE
        -- A ride in progress has a driver and no wait to report: its code and its route.
        v_title := 'Te pasamos un viaje en curso · #' || public._ride_short_code(v_id);
        v_body := left(COALESCE(v_ride.pickup_address, '—'), 60) || ' → ' || left(COALESCE(v_ride.dropoff_address, '—'), 60);
      END IF;
      PERFORM public._support_send('support-handoff', ARRAY[v_new], v_title, v_body, 'support_handoff', v_id);
      v_handed := v_handed + 1;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_kept
  FROM public.ride_assist ra
  JOIN public.rides r ON r.id = ra.ride_id
  WHERE ra.owner_id = p_user
    AND public._support_ride_open(r.status, ra.owner_opened_at);
  RETURN jsonb_build_object('handed_over', v_handed, 'kept', v_kept);
END
$function$;

-- When p_user comes on shift: every searching ride already alerted that has no owner, or whose owner
-- is off shift and never opened it, gets an owner by the assignment rule (her, or someone on shift
-- with fewer open rides), with a push. So do the rides she kept unopened while she was off (hers,
-- assigned before this shift started): they get a fresh owner_assigned_at, so the time she was off
-- never counts as a miss, and they may go back to her. A ride its owner opened stays hers: she may
-- be on it by WhatsApp. Returns how many were assigned.
CREATE OR REPLACE FUNCTION public._support_pickup_for(p_user uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_support_lock CONSTANT bigint := 6790000000001;  -- the support lock (see _support_pick_owner)
  v_started timestamptz;
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
  -- When this shift started: a ride of hers assigned before it was kept while she was off. A
  -- repeated "on" keeps the start, so it never restarts the minute of a ride of this shift.
  SELECT s.shift_started_at INTO v_started FROM public.support_staff s WHERE s.user_id = p_user;

  -- SKIP LOCKED: the caller holds the support lock (section E).
  v_ids := ARRAY(
    SELECT ra.ride_id
    FROM public.ride_assist ra
    JOIN public.rides r ON r.id = ra.ride_id
    WHERE r.status = 'searching'
      AND (ra.help_alert_sent_at IS NOT NULL OR ra.wait_alert_sent_at IS NOT NULL)
      AND (ra.owner_id IS NULL
           OR (ra.owner_opened_at IS NULL AND NOT public._support_staff_on_shift(ra.owner_id))
           OR (ra.owner_id = p_user AND ra.owner_opened_at IS NULL
               AND (ra.owner_assigned_at IS NULL OR ra.owner_assigned_at < v_started)))
    ORDER BY (ra.help_alert_sent_at IS NULL), GREATEST(r.created_at, r.scheduled_at), ra.ride_id
    FOR UPDATE OF ra SKIP LOCKED);

  PERFORM pg_advisory_xact_lock(c_support_lock);
  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT * INTO v_ra FROM public.ride_assist WHERE ride_id = v_id;
    -- Her own kept ride may go back to her: she is not excluded for having had it.
    v_new := public._support_pick_owner(v_id, CASE WHEN v_ra.owner_id = p_user
                                                   THEN array_remove(v_ra.owners_tried, p_user)
                                                   ELSE v_ra.owners_tried END);
    IF v_new IS NOT NULL THEN
      UPDATE public.ride_assist
         SET owner_id = v_new, owner_assigned_at = now(), owner_opened_at = NULL,
             all_missed_alert_at = NULL,
             owners_tried = CASE WHEN v_new = ANY (owners_tried) THEN owners_tried ELSE owners_tried || v_new END
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
CREATE OR REPLACE FUNCTION pg_temp.m00681_patch(p_fn regprocedure, p_old_md5 text, p_new_md5 text,
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
    RAISE EXCEPTION '00681: % has an unknown body (md5 %)', p_fn, v_md5;
  END IF;
  SELECT pg_get_functiondef(p_fn) INTO v_def;
  FOR i IN 1 .. array_length(p_olds, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_olds[i], ''))) / length(p_olds[i]) <> 1 THEN
      RAISE EXCEPTION '00681: % does not have text % exactly once', p_fn, i;
    END IF;
    v_def := replace(v_def, p_olds[i], p_news[i]);
  END LOOP;
  EXECUTE v_def;
END
$function$;

-- _support_alert: the whole body (the md5 pins it to prod's, 00632's). The ride gets its owner, and
-- only she is pushed; with nobody to give it to, or an owner off shift who opened it (she keeps
-- it), everyone is, as before. The texts are pasted with
-- their line ends stripped of chr(13), so a copy pasted from Windows patches the same.
SELECT pg_temp.m00681_patch('public._support_alert(uuid,text)', '992c2ce11b664d72e437a683170abb97',
  '776dd85d50c271d66f86c2a46ca7deb1',
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

  -- 00681: one owner on shift. An owner on shift keeps the ride. An owner off shift who opened it
  -- keeps it too (she may be on it by WhatsApp), and everyone is told, as when nobody is on shift.
  -- With no owner, or one off shift who never opened it, the assignment rule picks someone on shift
  -- who has not had it; with nobody to pick, such an owner stays (the panel shows her) and everyone
  -- is told. The caller (request_ride_help, the cron) already holds the ride_assist row.
  SELECT * INTO v_ra FROM public.ride_assist WHERE ride_id = p_ride_id FOR UPDATE;
  IF FOUND THEN
    IF v_ra.owner_id IS NOT NULL AND public._support_staff_on_shift(v_ra.owner_id) THEN
      v_owner := v_ra.owner_id;
    ELSIF v_ra.owner_id IS NULL OR v_ra.owner_opened_at IS NULL THEN
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
SELECT pg_temp.m00681_patch('public.request_ride_help(uuid)', '0568a44a41e6b9ef925ae1b2b2799cb1',
  '6d61d18cdba71a26c1ec4647ff9e372e',
  ARRAY[E'  RETURN jsonb_build_object(''success'', true, ''code'', public._ride_short_code(p_ride_id));'],
  ARRAY[E'  -- 00681: the number the rider writes to (the owner on shift, else the support contact).\n'
        || E'  RETURN jsonb_build_object(''success'', true, ''code'', public._ride_short_code(p_ride_id),\n'
        || E'                            ''support_phone'', public._support_phone_for_ride(p_ride_id));']);

-- notify_support_waiting_rides (the cron's wait alert): the same stamps, digest and pushes, in a new
-- order. _support_alert now takes the support lock and the run holds it until it commits, so every
-- ride_assist row the run writes (the wait stamps, the digest's e-mail stamps) is written before
-- its first alert, and the alerts go last. Before, the run took the lock alerting one ride and then
-- waited for the next ride's row, which a rider's help request could hold while it waited for the
-- lock: a deadlock that lost the help alert.
SELECT pg_temp.m00681_patch('public.notify_support_waiting_rides()', 'c69e1ca717436dad23eada26af46e0ce',
  'f2bc190a812fc03442921018e32fee44',
  ARRAY[E'  v_wait_ids uuid[] := ''{}'';\n',
        E'      IF FOUND THEN\n'
        || E'        PERFORM public._support_alert(v_id, ''wait'');\n'
        || E'        v_n := v_n + 1;\n'
        || E'      END IF;',
        E'  -- The digest, in a block of its own: a failure in it must not take back the pushes above.\n',
        E'\n  RETURN v_n;\nEND;'],
  ARRAY[E'  v_wait_ids uuid[] := ''{}'';\n'
        || E'  v_alert_ids uuid[] := ''{}'';  -- 00681: the rides to alert, once every row is written\n',
        E'      IF FOUND THEN\n'
        || E'        v_alert_ids := v_alert_ids || v_id;  -- 00681: alerted at the end (see below)\n'
        || E'        v_n := v_n + 1;\n'
        || E'      END IF;',
        E'  -- The digest, in a block of its own: a failure in it must not take back the wait stamps\n'
        || E'  -- above nor stop the pushes below.\n',
        E'\n'
        || E'  -- 00681: the pushes last. _support_alert takes the support lock and this run holds it until\n'
        || E'  -- it commits: every ride_assist row the run writes is written by now, so it never waits for\n'
        || E'  -- a row while it holds the lock (a help request holds its row, then waits for the lock).\n'
        || E'  FOREACH v_id IN ARRAY v_alert_ids LOOP\n'
        || E'    PERFORM public._support_alert(v_id, ''wait'');\n'
        || E'  END LOOP;\n'
        || E'\n  RETURN v_n;\nEND;']);

-- ── H. The handover tick in pg_cron ─────────────────────────
-- Every 20 s (pg_cron 1.6.4 takes seconds): a ride passes 60 to 80 s after it was assigned.
-- cron.schedule updates a job of the same name.
SELECT cron.schedule('support-handoff-tick', '20 seconds', 'SELECT public.support_handoff_tick()');

-- ── I. One owner in the assist actions, opening and taking ──
-- Locks in part 3. Each assist action locks its ride (rides) and then calls the guard, which locks
-- the ride's ride_assist row; the guard writes no support_staff row, so it takes no support lock.
-- ops_open_ride_assist locks the ride_assist row, then the support lock, then the caller's
-- support_staff row; ops_take_ride_assist the ride first, then the same. The order everywhere:
-- rides, ride_assist, support lock, support_staff.

-- The ownership guard, called by each assist action right after its own ride lock and self-ride
-- check: NULL when the caller may act, 'ride_owned_by_other' when someone else owns the ride. A ride
-- with no owner becomes the caller's, opened (she is on it, so the handover leaves it), with its
-- ride_assist row created if missing; that stays even when the action then refuses on its own
-- grounds. Its owner acting on it counts as opening it too (the first opening is kept). An owner
-- off shift still owns the ride: anyone else takes it first (ops_take_ride_assist), admins too.
CREATE OR REPLACE FUNCTION public._assist_claim_or_refuse(p_ride_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me    uuid := auth.uid();
  v_owner uuid;
BEGIN
  IF v_me IS NULL THEN
    RETURN 'forbidden';
  END IF;

  INSERT INTO public.ride_assist (ride_id) VALUES (p_ride_id) ON CONFLICT (ride_id) DO NOTHING;
  SELECT ra.owner_id INTO v_owner FROM public.ride_assist ra WHERE ra.ride_id = p_ride_id FOR UPDATE;
  IF v_owner IS NULL THEN
    UPDATE public.ride_assist
       SET owner_id = v_me, owner_assigned_at = now(), owner_opened_at = now(), all_missed_alert_at = NULL,
           owners_tried = CASE WHEN v_me = ANY (owners_tried) THEN owners_tried ELSE owners_tried || v_me END
     WHERE ride_id = p_ride_id;
    RETURN NULL;
  END IF;
  IF v_owner = v_me THEN
    -- Her acting on it counts as opening it (the cron may have given it to her after her page
    -- loaded): the handover then leaves it. The row is already locked; no support_staff write.
    UPDATE public.ride_assist SET owner_opened_at = now() WHERE ride_id = p_ride_id AND owner_opened_at IS NULL;
    RETURN NULL;
  END IF;
  RETURN 'ride_owned_by_other';
END
$function$;

-- The assist page, when it loads. Its owner opening it stamps owner_opened_at (the first time: the
-- handover then leaves the ride alone) and zeroes her missed rides. Anyone else: nothing changes.
CREATE OR REPLACE FUNCTION public.ops_open_ride_assist(p_ride_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_support_lock CONSTANT bigint := 6790000000001;  -- the support lock (see _support_pick_owner)
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL OR NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  UPDATE public.ride_assist SET owner_opened_at = COALESCE(owner_opened_at, now())
   WHERE ride_id = p_ride_id AND owner_id = v_me;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'is_owner', false);
  END IF;

  PERFORM pg_advisory_xact_lock(c_support_lock);
  UPDATE public.support_staff SET missed_in_a_row = 0, updated_at = now()
   WHERE user_id = v_me AND missed_in_a_row <> 0;
  RETURN jsonb_build_object('success', true, 'is_owner', true);
END
$function$;

-- "Tomar este viaje": the caller becomes the ride's owner, only if its owner is still the one she
-- saw (p_expected_owner_id, NULL for none): ride_changed otherwise. The ride counts as opened by
-- her, and her missed rides are zeroed. The owner she took it from gets a push (support-take: "<her
-- name> tomó el viaje #<code>"); a push that fails never takes back the take (_support_send). Logged
-- as support_take_ride. Never on a ride she rides in or drives. A second tap on a ride already hers
-- only counts as opening it.
CREATE OR REPLACE FUNCTION public.ops_take_ride_assist(p_ride_id uuid, p_expected_owner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_support_lock CONSTANT bigint := 6790000000001;  -- the support lock (see _support_pick_owner)
  v_me     uuid := auth.uid();
  v_ride   public.rides%ROWTYPE;
  v_driver uuid;
  v_prev   uuid;
  v_name   text;
BEGIN
  IF v_me IS NULL OR NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  SELECT dp.user_id INTO v_driver FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id;
  IF v_me = v_ride.customer_id OR v_me = v_driver THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;

  SELECT ra.owner_id INTO v_prev FROM public.ride_assist ra WHERE ra.ride_id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    -- No row yet: it has no owner, so only a take that saw none goes on.
    IF p_expected_owner_id IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'ride_changed');
    END IF;
    INSERT INTO public.ride_assist (ride_id) VALUES (p_ride_id) ON CONFLICT (ride_id) DO NOTHING;
    SELECT ra.owner_id INTO v_prev FROM public.ride_assist ra WHERE ra.ride_id = p_ride_id FOR UPDATE;
  END IF;
  IF v_prev IS DISTINCT FROM p_expected_owner_id THEN
    RETURN jsonb_build_object('error', 'ride_changed');
  END IF;

  IF v_prev IS NOT DISTINCT FROM v_me THEN
    UPDATE public.ride_assist SET owner_opened_at = COALESCE(owner_opened_at, now()) WHERE ride_id = p_ride_id;
  ELSE
    UPDATE public.ride_assist
       SET owner_id = v_me, owner_assigned_at = now(), owner_opened_at = now(), all_missed_alert_at = NULL,
           owners_tried = CASE WHEN v_me = ANY (owners_tried) THEN owners_tried ELSE owners_tried || v_me END
     WHERE ride_id = p_ride_id;
  END IF;
  PERFORM pg_advisory_xact_lock(c_support_lock);
  UPDATE public.support_staff SET missed_in_a_row = 0, updated_at = now()
   WHERE user_id = v_me AND missed_in_a_row <> 0;
  IF v_prev IS NOT DISTINCT FROM v_me THEN
    RETURN jsonb_build_object('success', true);
  END IF;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
  VALUES (v_me, 'support_take_ride', 'ride', p_ride_id::text,
          jsonb_build_object('owner_id', v_prev), jsonb_build_object('owner_id', v_me));

  IF v_prev IS NOT NULL THEN
    SELECT COALESCE(NULLIF(btrim(u.full_name), ''), 'Soporte') INTO v_name FROM public.users u WHERE u.id = v_me;
    PERFORM public._support_send('support-take', ARRAY[v_prev],
      v_name || ' tomó el viaje #' || public._ride_short_code(p_ride_id),
      left(COALESCE(v_ride.pickup_address, '—'), 60) || ' → ' || left(COALESCE(v_ride.dropoff_address, '—'), 60),
      'support_take', p_ride_id);
  END IF;
  RETURN jsonb_build_object('success', true);
END
$function$;

-- Who owns a ride, for the assist page (both contexts): {id, name, on_shift, assigned_at,
-- opened_at}, or NULL with no owner. on_shift as _support_staff_on_shift: an owner off shift still
-- owns the ride (nobody acts on it by surprise), but alerts and the rider's number skip her.
CREATE OR REPLACE FUNCTION public._support_ride_owner(p_ride_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT jsonb_build_object('id', ra.owner_id, 'name', u.full_name,
                            'on_shift', public._support_staff_on_shift(ra.owner_id),
                            'assigned_at', ra.owner_assigned_at, 'opened_at', ra.owner_opened_at)
  FROM public.ride_assist ra
  JOIN public.users u ON u.id = ra.owner_id
  WHERE ra.ride_id = p_ride_id;
$function$;

-- The banner: admin_support_waiting_rides (00628), the same rows, columns and order, plus who owns
-- each ride (owner_on_shift NULL with no owner). A new name, because a RETURNS TABLE gains columns
-- only through a DROP; v1 stays as it was until the panel no longer calls it.
CREATE OR REPLACE FUNCTION public.admin_support_waiting_rides_v2()
 RETURNS TABLE(ride_id uuid, code text, waiting_since timestamp with time zone, wait_s integer,
               help_requested_at timestamp with time zone, service_type text, estimated_fare_cup integer,
               pickup_address text, dropoff_address text, pending_offers integer, is_test boolean,
               owner_id uuid, owner_name text, owner_on_shift boolean,
               owner_assigned_at timestamp with time zone, owner_opened_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_after integer := GREATEST(15, public.get_platform_config_numeric('support_alert_after_s', 60)::int);
BEGIN
  IF NOT public.is_ops_staff() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id,
         public._ride_short_code(r.id),
         GREATEST(r.created_at, r.scheduled_at),
         GREATEST(0, floor(extract(epoch FROM now() - GREATEST(r.created_at, r.scheduled_at))))::int,
         ra.help_requested_at,
         r.service_type,
         r.estimated_fare_cup,
         r.pickup_address,
         r.dropoff_address,
         (SELECT count(*)::int FROM public.ride_offers o
           WHERE o.ride_id = r.id AND o.status = 'pending' AND o.expires_at > now()),
         c.is_test,
         ra.owner_id,
         ou.full_name,
         CASE WHEN ra.owner_id IS NOT NULL THEN public._support_staff_on_shift(ra.owner_id) END,
         ra.owner_assigned_at,
         ra.owner_opened_at
  FROM public.rides r
  JOIN public.users c ON c.id = r.customer_id
  LEFT JOIN public.ride_assist ra ON ra.ride_id = r.id
  LEFT JOIN public.users ou ON ou.id = ra.owner_id
  WHERE r.status = 'searching'
    AND GREATEST(r.created_at, r.scheduled_at) <= now()
    AND (ra.help_requested_at IS NOT NULL
         OR GREATEST(r.created_at, r.scheduled_at) <= now() - make_interval(secs => v_after))
  ORDER BY (ra.help_requested_at IS NULL), GREATEST(r.created_at, r.scheduled_at)
  LIMIT 50;
END
$function$;

-- ── J. The guard in the assist actions, the owner in the contexts ──
-- Patched like section G (m00681_patch, md5 of the bodies in prod on 2026-11-07). The seven
-- actions take the same two edits: a variable, and the guard right after the self-ride check, which
-- comes after the action's own lock of the ride (in admin_cancel_ride and the assign, right before
-- PERFORM public._ops_allow(ARRAY[p_ride_id]); in release, advance and complete, before their
-- _ops_allow). Every text is an E'' string, so a copy pasted from Windows patches the same.
SELECT pg_temp.m00681_patch(f.fn::regprocedure, f.old_md5, f.new_md5,
  ARRAY[E'\nDECLARE\n',
        E'    RETURN jsonb_build_object(''error'', ''self_ride'');\n  END IF;\n'],
  ARRAY[E'\nDECLARE\n'
        || E'  v_own text;  -- 00681: the ownership guard\n',
        E'    RETURN jsonb_build_object(''error'', ''self_ride'');\n  END IF;\n'
        || E'  -- 00681: one owner per ride. With no owner the caller becomes it; another owner refuses.\n'
        || E'  v_own := public._assist_claim_or_refuse(p_ride_id);\n'
        || E'  IF v_own IS NOT NULL THEN\n'
        || E'    RETURN jsonb_build_object(''error'', v_own);\n'
        || E'  END IF;\n'])
FROM (VALUES
  ('public.admin_offer_ride_to_driver(uuid,uuid)', '0085408045cc5fbf2dbc3e2eb0da92f5', '4a878a25798638296046482213f02738'),
  ('public.admin_assign_ride_to_driver(uuid,uuid,text)', '96a14f1ef39f9d397884457278efd699', 'd5f1ae456461ad3e4da3d8d7a2542bf2'),
  ('public.admin_change_ride_service(uuid,text,integer,text,text)', '06b0af6654384570c38a76389681d43a', '923187b6d30bc1d3b32c7b9974a2c38c'),
  ('public.admin_release_active_ride(uuid,text,uuid,text)', '8f18bf4984f52e41c93cdb16b062eeff', '9f09fb0de2a3ffbde4046d64785502b6'),
  ('public.admin_advance_active_ride(uuid,text,uuid,text)', 'bc7187cb8d4dbde6c64886e2ee9e3ff8', 'bf81807b07b6238d06c5d2358b5ab693'),
  ('public.admin_complete_active_ride(uuid,text,uuid,integer,text)', '149e13089c12d43458a75ee58dd2a9d3', '2494b271699e03da7a25ac467f0f23b7'),
  ('public.admin_cancel_ride(uuid,text)', '21b4dfa6427e7c8976ef1324ddfa732b', 'a9de85a9bbb12f207973715bd895af13')
) AS f(fn, old_md5, new_md5);

-- The two contexts of the assist page gain owner (_support_ride_owner; JSON null with no owner).
SELECT pg_temp.m00681_patch('public.admin_ride_assist_context(uuid)', '2b7a2a9cb6ca0566c3fde8614220e91a',
  '7dc43249a6575222595416f5a4357163',
  ARRAY[E'    ''help_requested_at'', ra.help_requested_at,\n'],
  ARRAY[E'    ''help_requested_at'', ra.help_requested_at,\n'
        || E'    ''owner'', public._support_ride_owner(v_ride.id),  -- 00681: who owns the ride\n']);
SELECT pg_temp.m00681_patch('public.admin_active_ride_context(uuid)', '62031d5be71f09241122be3e64bb3957',
  '350f050f3a233b93296ef8b9caa613f6',
  ARRAY[E'    ''allowed_actions'', to_jsonb(v_actions));\n'],
  ARRAY[E'    ''allowed_actions'', to_jsonb(v_actions),\n'
        || E'    ''owner'', public._support_ride_owner(v_ride.id));  -- 00681: who owns the ride\n']);

-- ── Permissions ─────────────────────────────────────────────
-- The helpers and the tick (pg_cron runs it as the owner) to nobody.
REVOKE ALL ON FUNCTION public._support_staff_on_shift(uuid),
                       public._support_ride_open(public.ride_status, timestamptz),
                       public._support_pick_owner(uuid, uuid[]),
                       public._support_alert_text(uuid, text),
                       public._support_send(text, uuid[], text, text, text, uuid),
                       public._support_phone_for_ride(uuid),
                       public._support_handoff_rides_of(uuid),
                       public._support_pickup_for(uuid),
                       public.support_handoff_tick(),
                       public._assist_claim_or_refuse(uuid),
                       public._support_ride_owner(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ops_set_support_shift(boolean, text),
                       public.ops_support_shift_status(),
                       public.get_support_contact(),
                       public.ops_open_ride_assist(uuid),
                       public.ops_take_ride_assist(uuid, uuid),
                       public.admin_support_waiting_rides_v2()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_set_support_shift(boolean, text),
                          public.ops_support_shift_status()
  TO authenticated, service_role;
-- The assist page (open, take) and the banner.
GRANT EXECUTE ON FUNCTION public.ops_open_ride_assist(uuid), public.ops_take_ride_assist(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_support_waiting_rides_v2() TO authenticated, service_role;
-- The help screens ask for it before login too (the driver waiting for approval, the web).
GRANT EXECUTE ON FUNCTION public.get_support_contact() TO anon, authenticated, service_role;
-- The patched bodies keep prod's grants (CREATE OR REPLACE keeps them).

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
    'public.support_handoff_tick()', 'public._support_ride_open(public.ride_status,timestamptz)',
    'public._assist_claim_or_refuse(uuid)', 'public.ops_open_ride_assist(uuid)',
    'public.ops_take_ride_assist(uuid,uuid)', 'public._support_ride_owner(uuid)',
    'public.admin_support_waiting_rides_v2()'
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
  v_fn  text;
  -- Every function this migration creates.
  v_new text[] := ARRAY[
    'public._support_staff_on_shift(uuid)', 'public._support_pick_owner(uuid,uuid[])',
    'public.get_support_contact()', 'public.ops_set_support_shift(boolean,text)',
    'public.ops_support_shift_status()', 'public._support_alert_text(uuid,text)',
    'public._support_send(text,uuid[],text,text,text,uuid)', 'public._support_phone_for_ride(uuid)',
    'public._support_handoff_rides_of(uuid)', 'public._support_pickup_for(uuid)',
    'public.support_handoff_tick()', 'public._support_ride_open(public.ride_status,timestamptz)',
    'public._assist_claim_or_refuse(uuid)', 'public.ops_open_ride_assist(uuid)',
    'public.ops_take_ride_assist(uuid,uuid)', 'public._support_ride_owner(uuid)',
    'public.admin_support_waiting_rides_v2()'];
  -- Every live body it patches.
  v_patched text[] := ARRAY[
    'public._support_alert(uuid,text)', 'public.request_ride_help(uuid)', 'public.notify_support_waiting_rides()',
    'public.admin_offer_ride_to_driver(uuid,uuid)', 'public.admin_assign_ride_to_driver(uuid,uuid,text)',
    'public.admin_change_ride_service(uuid,text,integer,text,text)',
    'public.admin_release_active_ride(uuid,text,uuid,text)', 'public.admin_advance_active_ride(uuid,text,uuid,text)',
    'public.admin_complete_active_ride(uuid,text,uuid,integer,text)', 'public.admin_cancel_ride(uuid,text)',
    'public.admin_ride_assist_context(uuid)', 'public.admin_active_ride_context(uuid)'];
BEGIN
  -- The new functions: each one present, and no other function under their names (a stray
  -- overload); each SECURITY DEFINER with its search_path.
  FOREACH v_fn IN ARRAY v_new LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION '00681 check: % is missing', v_fn;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN (SELECT q.proname FROM pg_proc q WHERE q.oid = ANY (SELECT to_regprocedure(f) FROM unnest(v_new) f)))
     <> cardinality(v_new) THEN
    RAISE EXCEPTION '00681 check: the new functions are not exactly the % of this file', cardinality(v_new);
  END IF;
  FOR v_row IN
    SELECT p.oid::regprocedure AS fn, p.prosecdef, p.proconfig FROM pg_proc p
    WHERE p.oid = ANY (SELECT to_regprocedure(f) FROM unnest(v_new) f)
  LOOP
    IF NOT v_row.prosecdef OR v_row.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_catalog'] THEN
      RAISE EXCEPTION '00681 check: % is not SECURITY DEFINER with its search_path', v_row.fn;
    END IF;
  END LOOP;

  -- support_staff: RLS on, one read policy, written only by the functions (and service_role).
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.support_staff'::regclass) THEN
    RAISE EXCEPTION '00681 check: RLS is off on support_staff';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'support_staff') <> 1
     OR has_table_privilege('anon', 'public.support_staff', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.support_staff', 'SELECT')
     OR has_table_privilege('authenticated', 'public.support_staff', 'INSERT')
     OR has_table_privilege('authenticated', 'public.support_staff', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.support_staff', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.support_staff', 'UPDATE') THEN
    RAISE EXCEPTION '00681 check: support_staff is not locked down';
  END IF;

  -- The helpers and the tick stay the owner's.
  FOR v_row IN
    SELECT f.fn FROM unnest(ARRAY[
      'public._support_staff_on_shift(uuid)', 'public._support_pick_owner(uuid,uuid[])',
      'public._support_alert_text(uuid,text)', 'public._support_send(text,uuid[],text,text,text,uuid)',
      'public._support_phone_for_ride(uuid)', 'public._support_handoff_rides_of(uuid)',
      'public._support_pickup_for(uuid)', 'public.support_handoff_tick()',
      'public._support_ride_open(public.ride_status,timestamptz)', 'public._assist_claim_or_refuse(uuid)',
      'public._support_ride_owner(uuid)'
    ]::regprocedure[]) AS f(fn)
  LOOP
    IF has_function_privilege('anon', v_row.fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_row.fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_row.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00681 check: the helpers are open to clients (%)', v_row.fn;
    END IF;
  END LOOP;

  -- The twelve patched bodies: the 00681 ones (md5 of prosrc, no carriage return), still SECURITY
  -- DEFINER with prod's search_path.
  FOR v_row IN
    SELECT f.fn, f.want, f.path, md5(p.prosrc) AS got, position(chr(13) IN p.prosrc) > 0 AS has_cr,
           p.prosecdef, p.proconfig
    FROM (VALUES
      ('public._support_alert(uuid,text)'::regprocedure, '776dd85d50c271d66f86c2a46ca7deb1', 'public, pg_catalog'),
      ('public.request_ride_help(uuid)', '6d61d18cdba71a26c1ec4647ff9e372e', 'public, pg_catalog'),
      ('public.notify_support_waiting_rides()', 'f2bc190a812fc03442921018e32fee44', 'public, pg_catalog'),
      ('public.admin_offer_ride_to_driver(uuid,uuid)', '4a878a25798638296046482213f02738', 'public, pg_catalog'),
      ('public.admin_assign_ride_to_driver(uuid,uuid,text)', 'd5f1ae456461ad3e4da3d8d7a2542bf2', 'public, pg_catalog'),
      ('public.admin_change_ride_service(uuid,text,integer,text,text)', '923187b6d30bc1d3b32c7b9974a2c38c',
       'public, extensions, pg_catalog'),
      ('public.admin_release_active_ride(uuid,text,uuid,text)', '9f09fb0de2a3ffbde4046d64785502b6', 'public, pg_catalog'),
      ('public.admin_advance_active_ride(uuid,text,uuid,text)', 'bf81807b07b6238d06c5d2358b5ab693',
       'public, extensions, pg_catalog'),
      ('public.admin_complete_active_ride(uuid,text,uuid,integer,text)', '2494b271699e03da7a25ac467f0f23b7',
       'public, extensions, pg_catalog'),
      ('public.admin_cancel_ride(uuid,text)', 'a9de85a9bbb12f207973715bd895af13', 'public, pg_catalog'),
      ('public.admin_ride_assist_context(uuid)', '7dc43249a6575222595416f5a4357163', 'public, pg_catalog'),
      ('public.admin_active_ride_context(uuid)', '350f050f3a233b93296ef8b9caa613f6', 'public, extensions, pg_catalog')
    ) AS f(fn, want, path)
    JOIN pg_proc p ON p.oid = f.fn
  LOOP
    IF v_row.got IS DISTINCT FROM v_row.want OR v_row.has_cr THEN
      RAISE EXCEPTION '00681 check: % has md5 %, expected %', v_row.fn, v_row.got, v_row.want;
    END IF;
    IF NOT v_row.prosecdef OR v_row.proconfig IS DISTINCT FROM ARRAY['search_path=' || v_row.path] THEN
      RAISE EXCEPTION '00681 check: % is not SECURITY DEFINER with its search_path', v_row.fn;
    END IF;
  END LOOP;
  -- With prod's grants: the alert and the cron closed to clients; the help button, the assist
  -- actions and the contexts open to signed-in users (each checks is_ops_staff or the rider).
  IF has_function_privilege('authenticated', 'public._support_alert(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.notify_support_waiting_rides()', 'EXECUTE') THEN
    RAISE EXCEPTION '00681 check: the patched functions have the wrong grants';
  END IF;
  FOREACH v_fn IN ARRAY v_patched[2:] LOOP
    IF v_fn <> 'public.notify_support_waiting_rides()'
       AND NOT has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '00681 check: the patched functions have the wrong grants (%)', v_fn;
    END IF;
  END LOOP;

  -- The handover tick is scheduled.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'support-handoff-tick' AND schedule = '20 seconds'
                   AND command = 'SELECT public.support_handoff_tick()') THEN
    RAISE EXCEPTION '00681 check: the support-handoff-tick job is missing';
  END IF;

  -- The panel's RPCs: authenticated, never anon. The contact: anon and authenticated.
  IF has_function_privilege('anon', 'public.ops_set_support_shift(boolean,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ops_support_shift_status()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.ops_set_support_shift(boolean,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.ops_support_shift_status()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.ops_open_ride_assist(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.ops_take_ride_assist(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_support_waiting_rides_v2()', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.get_support_contact()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_support_contact()', 'EXECUTE') THEN
    RAISE EXCEPTION '00681 check: the RPCs have the wrong grants';
  END IF;

  -- anon: of every function this migration creates or patches, only get_support_contact.
  FOR v_row IN
    SELECT p.oid::regprocedure AS fn FROM pg_proc p
    WHERE p.oid = ANY (SELECT to_regprocedure(f) FROM unnest(v_new || v_patched) f)
      AND has_function_privilege('anon', p.oid, 'EXECUTE') <> (p.oid = 'public.get_support_contact()'::regprocedure)
    ORDER BY p.oid::regprocedure::text
  LOOP
    RAISE EXCEPTION '00681 check: anon % %',
      CASE WHEN v_row.fn = 'public.get_support_contact()'::regprocedure THEN 'cannot execute' ELSE 'can execute' END,
      v_row.fn;
  END LOOP;
END
$check$;
