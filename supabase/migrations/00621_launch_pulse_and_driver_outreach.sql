-- 00621: weekly launch pulse + incomplete driver signups with an outreach log.
--
-- Why: the marketing launch of 2026-10-15 needs a weekly read of what actually
-- limits the service. Measured 2026-07-01..10-06 (non-test): 199 ride requests,
-- 88 never got an offer, 82 got offers nobody took, 19 were accepted and then
-- canceled, 10 completed. On average 1.31 drivers were online per hour and
-- nobody at all in 36.9 % of the hours. And 82 drivers started the signup and
-- never finished (62 without a single document).
--
--   driver_online_hourly             one row per UTC hour: which drivers were online.
--                                    The heartbeat log it comes from keeps only 30
--                                    days; this keeps the hourly summary for good.
--   snapshot_driver_online_hours()   fills it (cron every hour; the first run
--                                    backfills everything the heartbeat log still has)
--   admin_launch_pulse(p_weeks)      the weekly numbers for the admin, Havana weeks
--   driver_outreach_log              admin notes: "contacted this driver, when, what"
--   admin_incomplete_driver_signups() the drivers stuck in pending_verification,
--                                    with what they are missing and the last contact
--
-- Test accounts (users.is_test) are left out of every number.
--
-- Rehearsal: supabase/tests/00621/run.sh

-- 1. Online drivers per hour --------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.driver_online_hourly (
  hour_start timestamptz PRIMARY KEY,
  driver_ids uuid[] NOT NULL DEFAULT '{}',
  drivers_online integer GENERATED ALWAYS AS (cardinality(driver_ids)) STORED,
  computed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.driver_online_hourly IS
  '00621: driver_profiles.id of every driver with an online heartbeat in each UTC hour. Filled by snapshot_driver_online_hours().';

ALTER TABLE public.driver_online_hourly ENABLE ROW LEVEL SECURITY;
-- No policies: the cron writes it and admin_launch_pulse() reads it.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_online_hourly TO service_role;
REVOKE ALL ON public.driver_online_hourly FROM anon, authenticated;

-- Recomputes from the last stored hour (so an outage of the cron leaves no gap)
-- and always at least the last p_hours, up to the last complete hour. Hours the
-- heartbeat log no longer covers are never written: an empty hour there would
-- read as "nobody online" when it is really "no data".
CREATE OR REPLACE FUNCTION public.snapshot_driver_online_hours(p_hours integer DEFAULT 3)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_to timestamptz := date_trunc('hour', now(), 'UTC');
  v_log_start timestamptz;
  v_last timestamptz;
  v_from timestamptz;
  v_n integer;
BEGIN
  -- The first hour of the log is partial (it starts mid-hour or was pruned mid-hour).
  SELECT date_trunc('hour', min(beat_at), 'UTC') + interval '1 hour' INTO v_log_start
  FROM public.driver_heartbeat_log;
  IF v_log_start IS NULL THEN
    RETURN 0;
  END IF;

  SELECT max(hour_start) INTO v_last FROM public.driver_online_hourly;
  v_from := greatest(
    v_log_start,
    least(coalesce(v_last + interval '1 hour', v_log_start),
          v_to - make_interval(hours => greatest(coalesce(p_hours, 3), 1))));
  IF v_from >= v_to THEN
    RETURN 0;
  END IF;

  INSERT INTO public.driver_online_hourly AS t (hour_start, driver_ids, computed_at)
  SELECT h.hour_start,
         coalesce(array_agg(DISTINCT b.driver_profile_id ORDER BY b.driver_profile_id)
                    FILTER (WHERE b.driver_profile_id IS NOT NULL), '{}'),
         now()
  FROM generate_series(v_from, v_to - interval '1 hour', interval '1 hour') AS h(hour_start)
  LEFT JOIN (
    SELECT hb.driver_profile_id, date_trunc('hour', hb.beat_at, 'UTC') AS hour_start
    FROM public.driver_heartbeat_log hb
    JOIN public.driver_profiles dp ON dp.id = hb.driver_profile_id
    JOIN public.users u ON u.id = dp.user_id
    WHERE hb.is_online
      AND NOT coalesce(u.is_test, false)
      AND hb.beat_at >= v_from AND hb.beat_at < v_to
  ) b ON b.hour_start = h.hour_start
  GROUP BY h.hour_start
  ON CONFLICT (hour_start) DO UPDATE
    SET driver_ids = EXCLUDED.driver_ids, computed_at = EXCLUDED.computed_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

-- 2. The weekly pulse -----------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_launch_pulse(p_weeks integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_weeks integer := least(greatest(coalesce(p_weeks, 12), 1), 52);
  v_this_week date := date_trunc('week', now() AT TIME ZONE 'America/Havana')::date;
  v_first date := v_this_week - (v_weeks - 1) * 7;
  v_from timestamptz := v_first::timestamp AT TIME ZONE 'America/Havana';
  v_weeks_json jsonb;
  v_now_json jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  WITH weeks AS (
    SELECT d::date AS week_start,
           d::timestamp AT TIME ZONE 'America/Havana' AS ts_from,
           (d::date + 7)::timestamp AT TIME ZONE 'America/Havana' AS ts_to
    FROM generate_series(v_first, v_this_week, interval '7 days') AS d
  ),
  real_users AS (
    SELECT u.id, u.created_at, u.signup_code, u.marketing_opt_in, u.marketing_opt_in_at,
           EXISTS (SELECT 1 FROM public.driver_profiles dp WHERE dp.user_id = u.id) AS is_driver,
           EXISTS (SELECT 1 FROM public.user_devices d WHERE d.user_id = u.id) AS has_push
    FROM public.users u
    WHERE NOT coalesce(u.is_test, false)
  ),
  ride_rows AS (
    SELECT r.id, r.customer_id, r.status::text AS status, r.created_at,
           (r.accepted_at IS NOT NULL OR r.driver_id IS NOT NULL) AS was_accepted,
           EXISTS (SELECT 1 FROM public.ride_offers o WHERE o.ride_id = r.id) AS had_offer
    FROM public.rides r
    JOIN public.users u ON u.id = r.customer_id
    WHERE NOT coalesce(u.is_test, false) AND r.created_at >= v_from
  ),
  rides_w AS (
    SELECT w.week_start,
      count(rr.id) AS requests,
      count(DISTINCT rr.customer_id) AS riders_requesting,
      count(rr.id) FILTER (WHERE rr.status = 'completed') AS completed,
      count(DISTINCT rr.customer_id) FILTER (WHERE rr.status = 'completed') AS riders_completed,
      count(rr.id) FILTER (WHERE rr.status = 'canceled' AND rr.was_accepted) AS accepted_canceled,
      count(rr.id) FILTER (WHERE rr.status = 'canceled' AND NOT rr.was_accepted AND rr.had_offer) AS offered_not_accepted,
      count(rr.id) FILTER (WHERE rr.status = 'canceled' AND NOT rr.was_accepted AND NOT rr.had_offer) AS no_offer,
      count(rr.id) FILTER (WHERE rr.status NOT IN ('completed', 'canceled')) AS open
    FROM weeks w
    LEFT JOIN ride_rows rr ON rr.created_at >= w.ts_from AND rr.created_at < w.ts_to
    GROUP BY w.week_start
  ),
  online_w AS (
    SELECT w.week_start,
      count(h.hour_start) AS hours_measured,
      round(avg(h.drivers_online), 2) AS online_avg,
      round(avg(h.drivers_online) FILTER (
        WHERE extract(hour FROM h.hour_start AT TIME ZONE 'America/Havana') BETWEEN 7 AND 20), 2) AS online_avg_day,
      round(avg(h.drivers_online) FILTER (
        WHERE extract(hour FROM h.hour_start AT TIME ZONE 'America/Havana') NOT BETWEEN 7 AND 20), 2) AS online_avg_night,
      round(100.0 * count(h.hour_start) FILTER (WHERE h.drivers_online = 0)
            / nullif(count(h.hour_start), 0), 1) AS hours_nobody_pct,
      (SELECT count(DISTINCT x) FROM public.driver_online_hourly h2, unnest(h2.driver_ids) AS x
        WHERE h2.hour_start >= w.ts_from AND h2.hour_start < w.ts_to) AS drivers_seen_online
    FROM weeks w
    LEFT JOIN public.driver_online_hourly h ON h.hour_start >= w.ts_from AND h.hour_start < w.ts_to
    GROUP BY w.week_start, w.ts_from, w.ts_to
  ),
  users_w AS (
    SELECT w.week_start,
      count(ru.id) FILTER (WHERE NOT ru.is_driver) AS rider_signups,
      count(ru.id) FILTER (WHERE ru.signup_code IS NOT NULL) AS coded_signups,
      count(ru.id) FILTER (WHERE ru.has_push) AS signups_with_push,
      count(ru.id) AS signups
    FROM weeks w
    LEFT JOIN real_users ru ON ru.created_at >= w.ts_from AND ru.created_at < w.ts_to
    GROUP BY w.week_start
  ),
  consent_w AS (
    SELECT w.week_start, count(ru.id) AS marketing_opt_ins
    FROM weeks w
    LEFT JOIN real_users ru ON ru.marketing_opt_in
      AND ru.marketing_opt_in_at >= w.ts_from AND ru.marketing_opt_in_at < w.ts_to
    GROUP BY w.week_start
  ),
  drivers_w AS (
    SELECT w.week_start,
      count(dp.id) FILTER (WHERE dp.created_at >= w.ts_from AND dp.created_at < w.ts_to) AS driver_signups,
      count(dp.id) FILTER (WHERE dp.approved_at >= w.ts_from AND dp.approved_at < w.ts_to) AS drivers_approved
    FROM weeks w
    LEFT JOIN (
      SELECT dp.id, dp.created_at, dp.approved_at
      FROM public.driver_profiles dp
      JOIN public.users u ON u.id = dp.user_id
      WHERE NOT coalesce(u.is_test, false)
    ) dp ON (dp.created_at >= w.ts_from AND dp.created_at < w.ts_to)
         OR (dp.approved_at >= w.ts_from AND dp.approved_at < w.ts_to)
    GROUP BY w.week_start
  ),
  referrals_w AS (
    SELECT w.week_start,
      count(rf.id) FILTER (WHERE rf.created_at >= w.ts_from AND rf.created_at < w.ts_to) AS referrals_created,
      count(rf.id) FILTER (WHERE rf.rewarded_at >= w.ts_from AND rf.rewarded_at < w.ts_to) AS referrals_rewarded
    FROM weeks w
    LEFT JOIN (
      SELECT rf.id, rf.created_at, rf.rewarded_at
      FROM public.referrals rf
      JOIN public.users u ON u.id = rf.referee_id
      WHERE NOT coalesce(u.is_test, false)
    ) rf ON (rf.created_at >= w.ts_from AND rf.created_at < w.ts_to)
         OR (rf.rewarded_at >= w.ts_from AND rf.rewarded_at < w.ts_to)
    GROUP BY w.week_start
  )
  SELECT jsonb_agg(jsonb_build_object(
      'week_start', w.week_start,
      'is_current', w.week_start = v_this_week,
      'requests', r.requests,
      'riders_requesting', r.riders_requesting,
      'completed', r.completed,
      'riders_completed', r.riders_completed,
      'accepted_canceled', r.accepted_canceled,
      'offered_not_accepted', r.offered_not_accepted,
      'no_offer', r.no_offer,
      'open', r.open,
      'hours_measured', o.hours_measured,
      'online_avg', o.online_avg,
      'online_avg_day', o.online_avg_day,
      'online_avg_night', o.online_avg_night,
      'hours_nobody_pct', o.hours_nobody_pct,
      'drivers_seen_online', o.drivers_seen_online,
      'signups', u.signups,
      'rider_signups', u.rider_signups,
      'driver_signups', d.driver_signups,
      'drivers_approved', d.drivers_approved,
      'coded_signups', u.coded_signups,
      'signups_with_push', u.signups_with_push,
      'marketing_opt_ins', c.marketing_opt_ins,
      'referrals_created', f.referrals_created,
      'referrals_rewarded', f.referrals_rewarded
    ) ORDER BY w.week_start DESC)
  INTO v_weeks_json
  FROM weeks w
  JOIN rides_w r USING (week_start)
  JOIN online_w o USING (week_start)
  JOIN users_w u USING (week_start)
  JOIN consent_w c USING (week_start)
  JOIN drivers_w d USING (week_start)
  JOIN referrals_w f USING (week_start);

  SELECT jsonb_build_object(
    'users', count(*),
    'users_with_push', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.user_devices d WHERE d.user_id = u.id)),
    'users_opted_in', count(*) FILTER (WHERE u.marketing_opt_in),
    'drivers_approved', count(dp.id) FILTER (WHERE dp.status = 'approved'),
    'drivers_approved_with_push', count(dp.id) FILTER (WHERE dp.status = 'approved'
      AND EXISTS (SELECT 1 FROM public.user_devices d WHERE d.user_id = u.id)),
    'drivers_pending', count(dp.id) FILTER (WHERE dp.status = 'pending_verification'),
    'drivers_under_review', count(dp.id) FILTER (WHERE dp.status = 'under_review'),
    'drivers_online_now', count(dp.id) FILTER (WHERE dp.status = 'approved' AND dp.is_online)
  )
  INTO v_now_json
  FROM public.users u
  LEFT JOIN public.driver_profiles dp ON dp.user_id = u.id
  WHERE NOT coalesce(u.is_test, false);

  RETURN jsonb_build_object(
    'generated_at', now(),
    'timezone', 'America/Havana',
    'online_since', (SELECT min(hour_start) FROM public.driver_online_hourly),
    'now', v_now_json,
    'weeks', coalesce(v_weeks_json, '[]'::jsonb)
  );
END;
$function$;

-- 3. Drivers who started the signup and did not finish ------------------------------

CREATE TABLE IF NOT EXISTS public.driver_outreach_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_profile_id uuid NOT NULL REFERENCES public.driver_profiles(id) ON DELETE CASCADE,
  admin_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  channel text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'llamada', 'sms', 'otro')),
  note text CHECK (note IS NULL OR length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.driver_outreach_log IS
  '00621: an admin contacted a driver whose signup is incomplete. Append-only from the admin.';

CREATE INDEX IF NOT EXISTS idx_driver_outreach_log_driver
  ON public.driver_outreach_log (driver_profile_id, created_at DESC);

ALTER TABLE public.driver_outreach_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS driver_outreach_log_admin_select ON public.driver_outreach_log;
CREATE POLICY driver_outreach_log_admin_select ON public.driver_outreach_log
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS driver_outreach_log_admin_insert ON public.driver_outreach_log;
CREATE POLICY driver_outreach_log_admin_insert ON public.driver_outreach_log
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_admin()));

-- Until 2026-10-30 prod still grants every new table to anon and authenticated by
-- default. Take that back, so the log is append-only by grants and not only by RLS.
REVOKE ALL ON public.driver_outreach_log FROM anon, authenticated;
GRANT SELECT, INSERT ON public.driver_outreach_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_outreach_log TO service_role;

-- Who and when come from the session, not from the client.
CREATE OR REPLACE FUNCTION public.tg_driver_outreach_log_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.admin_id := auth.uid();
    NEW.created_at := now();
  END IF;
  NEW.note := nullif(btrim(NEW.note), '');
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_driver_outreach_log_stamp ON public.driver_outreach_log;
CREATE TRIGGER trg_driver_outreach_log_stamp
  BEFORE INSERT ON public.driver_outreach_log
  FOR EACH ROW EXECUTE FUNCTION public.tg_driver_outreach_log_stamp();

-- The five documents the approval needs (admin drivers/[id] REQUIRED_DOC_TYPES,
-- driver onboarding store, auto-admin REQUIRED_DOCS). Documents upload as the
-- driver goes; the vehicle, the ID number and the terms are only saved when the
-- driver sends the application (onboarding/review.tsx), so a driver still in
-- pending_verification never has them and they are not listed here (measured
-- 2026-10-06: 0 of the 82 had a vehicle).
CREATE OR REPLACE FUNCTION public.admin_incomplete_driver_signups()
 RETURNS TABLE (
   driver_profile_id uuid,
   user_id uuid,
   full_name text,
   phone text,
   signed_up_at timestamptz,
   last_sign_in_at timestamptz,
   docs_uploaded integer,
   missing_docs text[],
   rejected_docs text[],
   has_push boolean,
   contact_count integer,
   last_contact_at timestamptz,
   last_contact_by text,
   last_contact_channel text,
   last_contact_note text
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH req(doc_type, pos) AS (
    VALUES ('national_id', 1), ('selfie', 2), ('drivers_license', 3),
           ('vehicle_registration', 4), ('vehicle_photo', 5)
  ),
  base AS (
    SELECT dp.id, dp.user_id, u.full_name, u.phone, dp.created_at, au.last_sign_in_at
    FROM public.driver_profiles dp
    JOIN public.users u ON u.id = dp.user_id
    LEFT JOIN auth.users au ON au.id = dp.user_id
    WHERE dp.status = 'pending_verification'
      AND NOT coalesce(u.is_test, false)
  ),
  latest AS (
    SELECT DISTINCT ON (d.driver_id, d.document_type)
           d.driver_id, d.document_type::text AS doc_type, d.rejection_reason
    FROM public.driver_documents d
    WHERE d.driver_id IN (SELECT b.id FROM base b)
    ORDER BY d.driver_id, d.document_type, d.uploaded_at DESC NULLS LAST, d.id DESC
  ),
  contacts AS (
    SELECT DISTINCT ON (o.driver_profile_id)
           o.driver_profile_id, o.created_at, a.full_name AS by_name, o.channel, o.note,
           count(*) OVER (PARTITION BY o.driver_profile_id) AS n
    FROM public.driver_outreach_log o
    LEFT JOIN public.users a ON a.id = o.admin_id
    ORDER BY o.driver_profile_id, o.created_at DESC, o.id DESC
  )
  SELECT
    b.id,
    b.user_id,
    b.full_name,
    b.phone,
    b.created_at,
    b.last_sign_in_at,
    (SELECT count(*) FROM latest l JOIN req ON req.doc_type = l.doc_type
      WHERE l.driver_id = b.id AND l.rejection_reason IS NULL)::integer,
    coalesce((SELECT array_agg(req.doc_type ORDER BY req.pos) FROM req
      WHERE NOT EXISTS (SELECT 1 FROM latest l WHERE l.driver_id = b.id AND l.doc_type = req.doc_type)),
      '{}'::text[]),
    coalesce((SELECT array_agg(l.doc_type ORDER BY l.doc_type) FROM latest l
      WHERE l.driver_id = b.id AND l.rejection_reason IS NOT NULL), '{}'::text[]),
    EXISTS (SELECT 1 FROM public.user_devices ud WHERE ud.user_id = b.user_id),
    coalesce(c.n, 0)::integer,
    c.created_at,
    c.by_name,
    c.channel,
    c.note
  FROM base b
  LEFT JOIN contacts c ON c.driver_profile_id = b.id
  ORDER BY b.created_at DESC;
END;
$function$;

-- 4. Who may call what. New functions are born executable by PUBLIC.
DO $grants$
DECLARE r text;
BEGIN
  REVOKE ALL ON FUNCTION public.snapshot_driver_online_hours(integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.admin_launch_pulse(integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.tg_driver_outreach_log_stamp() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.admin_incomplete_driver_signups() FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.snapshot_driver_online_hours(integer) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.admin_launch_pulse(integer) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.tg_driver_outreach_log_stamp() FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.admin_incomplete_driver_signups() FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.admin_launch_pulse(integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.admin_incomplete_driver_signups() TO authenticated;
  END IF;
END $grants$;

-- 5. Backfill what the heartbeat log still has, then every hour. -------------------
SELECT public.snapshot_driver_online_hours();

SELECT cron.unschedule('snapshot-driver-online-hours')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'snapshot-driver-online-hours');
SELECT cron.schedule('snapshot-driver-online-hours', '7 * * * *', 'SELECT public.snapshot_driver_online_hours();');
