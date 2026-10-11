-- 00656: team daily digest (docs/superpowers/specs/2026-10-11-team-daily-digest-design.md).
--
-- At 7:00 Havana time every panel account (super_admin, admin, marketing) gets an e-mail with the
-- previous day's numbers. The send-team-digest Edge Function renders and sends it; this file holds
-- the database side:
--   1. team_digest_runs (one row per day: the day is sent once) and team_digest_optouts, both lock
--      tables for the service role only; the settings team_digest_enabled (off at launch) and
--      team_digest_preview_to (one account id: only that account gets it).
--   2. _team_digest_totals(day) and team_daily_metrics(day): every number of the e-mail.
--   3. team_digest_recipients(), claim_team_digest(day), finish_team_digest(...),
--      set_team_digest_optout(user, out).
--   4. dispatch_team_digest() (cron, hourly at :05) and check_team_digest_overdue() (cron, */15).
-- Functions the cron calls let their errors through (CLAUDE.md, "Una función de cron no atrapa sus
-- propios errores"). Rehearsal: supabase/tests/00656/run.sh.

SET lock_timeout = '10s';

-- 1. Run log, opt-outs and settings ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_digest_runs (
  day         date PRIMARY KEY,
  status      text NOT NULL DEFAULT 'sending',
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  recipients  integer NOT NULL DEFAULT 0,
  sent        integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  last_error  text,
  CONSTRAINT team_digest_runs_status_check CHECK (status IN ('sending', 'sent', 'failed'))
);
-- One row per person who chose; opted_out = false is a person who came back. Kept as a flag so
-- coming back is an UPDATE, never a DELETE.
CREATE TABLE IF NOT EXISTS public.team_digest_optouts (
  user_id    uuid PRIMARY KEY REFERENCES public.users (id) ON DELETE CASCADE,
  opted_out  boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Lock tables: only the SECURITY DEFINER functions below and the service role touch them.
ALTER TABLE public.team_digest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_digest_optouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_digest_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.team_digest_optouts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_digest_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_digest_optouts TO service_role;

INSERT INTO public.platform_config (key, value) VALUES
  ('team_digest_enabled', '"false"'::jsonb),
  ('team_digest_preview_to', '""'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 2. The numbers ---------------------------------------------------------------------------
-- One Havana calendar day. Test accounts and the platform account never count. Ride outcomes use
-- the rides REQUESTED that day, read now; "canceled by the rider" and "by the driver" only count
-- rides that had a driver, and a ride nobody accepted is "no driver" whoever canceled it, so no
-- ride is counted twice.
CREATE OR REPLACE FUNCTION public._team_digest_totals(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  c_platform CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  v_start timestamptz := (p_day::timestamp AT TIME ZONE 'America/Havana');
  v_end   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'America/Havana');
  v_hours integer;
  v_rides jsonb;
  v_signups jsonb;
  v_money jsonb;
  v_marketing jsonb;
  v_online integer;
  v_covered integer;
BEGIN
  -- Havana falls back from 01:00 to 00:00 on the first Sunday of November, so that day's local
  -- midnight happens twice and Postgres reads p_day::timestamp as the later one. The day starts
  -- at the first: step back an hour when the hour before is still the same Havana date.
  IF ((v_start - interval '1 hour') AT TIME ZONE 'America/Havana')::date = p_day THEN
    v_start := v_start - interval '1 hour';
  END IF;
  IF ((v_end - interval '1 hour') AT TIME ZONE 'America/Havana')::date = p_day + 1 THEN
    v_end := v_end - interval '1 hour';
  END IF;

  -- 23, 24 or 25: the daylight-saving days are shorter or longer.
  v_hours := round(extract(epoch FROM (v_end - v_start)) / 3600)::integer;

  WITH r AS (
    SELECT r.id, r.status, r.driver_id, r.canceled_by, r.customer_id, dp.user_id AS driver_user_id
    FROM public.rides r
    JOIN public.users cu ON cu.id = r.customer_id AND NOT cu.is_test
    LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
    LEFT JOIN public.users du ON du.id = dp.user_id
    WHERE r.created_at >= v_start AND r.created_at < v_end
      AND r.customer_id <> c_platform
      AND NOT coalesce(du.is_test, false)
  )
  SELECT jsonb_build_object(
    'requested', count(*),
    'completed', count(*) FILTER (WHERE r.status = 'completed'),
    'canceled_by_rider', count(*) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NOT NULL
                                            AND r.canceled_by = r.customer_id),
    'canceled_by_driver', count(*) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NOT NULL
                                             AND r.canceled_by = r.driver_user_id),
    'no_driver', count(*) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NULL),
    'no_driver_with_offer', count(*) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NULL
                                               AND EXISTS (SELECT 1 FROM public.ride_offers o WHERE o.ride_id = r.id)),
    'no_driver_without_offer', count(*) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NULL
                                                  AND NOT EXISTS (SELECT 1 FROM public.ride_offers o WHERE o.ride_id = r.id))
  ) INTO v_rides
  FROM r;

  -- Havana's offsets are whole hours, so an hour bucket is the same in UTC and in Havana.
  SELECT count(DISTINCT h.driver_profile_id), count(DISTINCT date_trunc('hour', h.beat_at))
    INTO v_online, v_covered
  FROM public.driver_heartbeat_log h
  JOIN public.driver_profiles dp ON dp.id = h.driver_profile_id
  JOIN public.users u ON u.id = dp.user_id AND NOT u.is_test
  WHERE h.is_online AND h.beat_at >= v_start AND h.beat_at < v_end;
  v_rides := v_rides || jsonb_build_object('hours_without_coverage', v_hours - v_covered);

  SELECT jsonb_build_object(
    'new_riders', (SELECT count(*) FROM public.users u
                   WHERE u.created_at >= v_start AND u.created_at < v_end AND NOT u.is_test AND u.id <> c_platform
                     AND NOT EXISTS (SELECT 1 FROM public.driver_profiles dp WHERE dp.user_id = u.id)),
    'drivers_registered', (SELECT count(*) FROM public.driver_profiles dp
                           JOIN public.users u ON u.id = dp.user_id AND NOT u.is_test
                           WHERE dp.created_at >= v_start AND dp.created_at < v_end),
    'drivers_approved', (SELECT count(*) FROM public.driver_profiles dp
                         JOIN public.users u ON u.id = dp.user_id AND NOT u.is_test
                         WHERE dp.approved_at >= v_start AND dp.approved_at < v_end),
    'drivers_online', v_online,
    'drivers_with_ride', (SELECT count(DISTINCT r.driver_id) FROM public.rides r
                          JOIN public.users cu ON cu.id = r.customer_id AND NOT cu.is_test
                          JOIN public.driver_profiles dp ON dp.id = r.driver_id
                          JOIN public.users du ON du.id = dp.user_id AND NOT du.is_test
                          WHERE r.status = 'completed' AND r.completed_at >= v_start AND r.completed_at < v_end)
  ) INTO v_signups;

  WITH done AS (
    SELECT r.id, r.final_fare_cup
    FROM public.rides r
    JOIN public.users cu ON cu.id = r.customer_id AND NOT cu.is_test
    LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
    LEFT JOIN public.users du ON du.id = dp.user_id
    WHERE r.status = 'completed' AND r.completed_at >= v_start AND r.completed_at < v_end
      AND r.customer_id <> c_platform AND NOT coalesce(du.is_test, false)
  )
  SELECT jsonb_build_object(
    'charged', coalesce((SELECT sum(d.final_fare_cup) FROM done d), 0)::bigint,
    'commission', coalesce((SELECT sum(s.commission_amount) FROM public.ride_pricing_snapshots s
                            JOIN done d ON d.id = s.ride_id WHERE s.snapshot_type = 'final'), 0)::bigint,
    'recharged', coalesce((SELECT sum(pi.amount_cup) FROM public.payment_intents pi
                           LEFT JOIN public.users u ON u.id = pi.user_id
                           WHERE pi.status = 'completed' AND pi.paid_at >= v_start AND pi.paid_at < v_end
                             AND NOT coalesce(u.is_test, false)), 0)::bigint
  ) INTO v_money;

  SELECT jsonb_build_object(
    'signups_with_code', (SELECT count(*) FROM public.users u
                          WHERE u.created_at >= v_start AND u.created_at < v_end AND NOT u.is_test
                            AND u.signup_code IS NOT NULL),
    'referrals', (SELECT count(*) FROM public.referrals rf WHERE rf.created_at >= v_start AND rf.created_at < v_end),
    'first_rides', (SELECT count(DISTINCT r.customer_id) FROM public.rides r
                    JOIN public.users cu ON cu.id = r.customer_id AND NOT cu.is_test
                    WHERE r.status = 'completed' AND r.completed_at >= v_start AND r.completed_at < v_end
                      AND NOT EXISTS (SELECT 1 FROM public.rides p
                                      WHERE p.customer_id = r.customer_id AND p.status = 'completed'
                                        AND p.completed_at < v_start)),
    'campaigns_sent', (SELECT count(*) FROM public.campaigns c
                       WHERE c.status = 'sent' AND c.sent_at >= v_start AND c.sent_at < v_end),
    'promotion_uses', (SELECT count(*) FROM public.promotion_uses pu
                       WHERE pu.created_at >= v_start AND pu.created_at < v_end)
  ) INTO v_marketing;

  RETURN jsonb_build_object('rides', v_rides, 'signups', v_signups, 'money', v_money, 'marketing', v_marketing);
END;
$$;

-- Everything the e-mail shows for day p_day: the totals of the day, the day before and a week
-- before; the breakdowns of the rides requested that day; what is pending now; and the lists.
-- A municipality of null is a pickup outside every polygon (rides.pickup_location is NOT NULL).
CREATE OR REPLACE FUNCTION public.team_daily_metrics(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  c_platform CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  v_start timestamptz := (p_day::timestamp AT TIME ZONE 'America/Havana');
  v_end   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'America/Havana');
  v_breakdowns jsonb;
  v_pending jsonb;
  v_lists jsonb;
BEGIN
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'team_daily_metrics: p_day is required' USING DETAIL = 'team_digest_bad_day';
  END IF;
  -- Same first-midnight rule as _team_digest_totals (Havana falls back at 01:00 in November).
  IF ((v_start - interval '1 hour') AT TIME ZONE 'America/Havana')::date = p_day THEN
    v_start := v_start - interval '1 hour';
  END IF;
  IF ((v_end - interval '1 hour') AT TIME ZONE 'America/Havana')::date = p_day + 1 THEN
    v_end := v_end - interval '1 hour';
  END IF;

  WITH r AS (
    SELECT r.id, r.status, r.driver_id, r.service_type, r.pickup_location,
           extract(hour FROM (r.created_at AT TIME ZONE 'America/Havana'))::integer AS hh
    FROM public.rides r
    JOIN public.users cu ON cu.id = r.customer_id AND NOT cu.is_test
    LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
    LEFT JOIN public.users du ON du.id = dp.user_id
    WHERE r.created_at >= v_start AND r.created_at < v_end
      AND r.customer_id <> c_platform AND NOT coalesce(du.is_test, false)
  ),
  places AS (
    SELECT a.municipality AS name, r.status, r.driver_id
    FROM r LEFT JOIN LATERAL public._poi_admin_area(r.pickup_location) a ON true
  ),
  muni AS (
    SELECT p.name, count(*) AS requested,
           count(*) FILTER (WHERE p.status = 'completed') AS completed,
           count(*) FILTER (WHERE p.status = 'canceled' AND p.driver_id IS NULL) AS no_driver
    FROM places p GROUP BY p.name ORDER BY count(*) DESC, p.name LIMIT 5
  ),
  veh AS (
    SELECT r.service_type AS slug, coalesce(s.name_es, r.service_type) AS name, count(*) AS requested,
           count(*) FILTER (WHERE r.status = 'completed') AS completed,
           count(*) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NULL) AS no_driver
    FROM r LEFT JOIN public.service_type_configs s ON s.slug = r.service_type
    GROUP BY r.service_type, s.name_es
  ),
  bands AS (
    SELECT b.band, b.ord, count(r.id) AS requested,
           count(r.id) FILTER (WHERE r.status = 'canceled' AND r.driver_id IS NULL) AS no_driver
    FROM (VALUES ('dawn', 1, 0, 6), ('morning', 2, 6, 12), ('afternoon', 3, 12, 18), ('night', 4, 18, 24))
         AS b(band, ord, h_from, h_to)
    LEFT JOIN r ON r.hh >= b.h_from AND r.hh < b.h_to
    GROUP BY b.band, b.ord
  )
  SELECT jsonb_build_object(
    'municipalities', coalesce((SELECT jsonb_agg(jsonb_build_object('name', m.name, 'requested', m.requested,
                                  'completed', m.completed, 'no_driver', m.no_driver) ORDER BY m.requested DESC, m.name)
                                FROM muni m), '[]'::jsonb),
    'vehicles', coalesce((SELECT jsonb_agg(jsonb_build_object('slug', v.slug, 'name', v.name, 'requested', v.requested,
                            'completed', v.completed, 'no_driver', v.no_driver) ORDER BY v.requested DESC, v.name)
                          FROM veh v), '[]'::jsonb),
    'bands', (SELECT jsonb_agg(jsonb_build_object('band', b.band, 'requested', b.requested, 'no_driver', b.no_driver)
                               ORDER BY b.ord) FROM bands b)
  ) INTO v_breakdowns;

  SELECT jsonb_build_object(
    'drivers_under_review', (SELECT count(*) FROM public.driver_profiles dp
                             JOIN public.users u ON u.id = dp.user_id AND NOT u.is_test
                             WHERE dp.status = 'under_review'),
    'incidents_open', (SELECT count(*) FROM public.incident_reports i WHERE i.status IN ('open', 'investigating')),
    'sos_open', (SELECT count(*) FROM public.incident_reports i
                 WHERE i.status IN ('open', 'investigating') AND i.type = 'sos'),
    'disputes_open', (SELECT count(*) FROM public.ride_disputes d WHERE d.resolved_at IS NULL),
    'disputes_overdue', (SELECT count(*) FROM public.ride_disputes d
                         WHERE d.resolved_at IS NULL AND d.sla_resolution_deadline < now())
  ) INTO v_pending;

  SELECT jsonb_build_object(
    'signup_codes', coalesce((SELECT jsonb_agg(t.x ORDER BY (t.x->>'signups')::integer DESC, t.x->>'code') FROM (
        SELECT jsonb_build_object('code', u.signup_code, 'label', ac.label, 'signups', count(*)) AS x
        FROM public.users u LEFT JOIN public.acquisition_codes ac ON ac.code = u.signup_code
        WHERE u.created_at >= v_start AND u.created_at < v_end AND NOT u.is_test AND u.signup_code IS NOT NULL
        GROUP BY u.signup_code, ac.label
        ORDER BY count(*) DESC, u.signup_code LIMIT 5) t), '[]'::jsonb),
    'campaigns', coalesce((SELECT jsonb_agg(jsonb_build_object('name', c.name, 'status', c.status,
                             'push_sent', c.push_sent, 'email_sent', c.email_sent) ORDER BY c.sent_at, c.id)
                           FROM public.campaigns c
                           WHERE c.sent_at >= v_start AND c.sent_at < v_end AND c.status IN ('sent', 'failed')), '[]'::jsonb),
    'promotions', coalesce((SELECT jsonb_agg(t.x ORDER BY (t.x->>'uses')::integer DESC, t.x->>'code') FROM (
        SELECT jsonb_build_object('code', p.code, 'uses', count(*)) AS x
        FROM public.promotion_uses pu JOIN public.promotions p ON p.id = pu.promotion_id
        WHERE pu.created_at >= v_start AND pu.created_at < v_end
        GROUP BY p.code ORDER BY count(*) DESC, p.code LIMIT 10) t), '[]'::jsonb)
  ) INTO v_lists;

  RETURN jsonb_build_object(
    'day', to_char(p_day, 'YYYY-MM-DD'),
    'current', public._team_digest_totals(p_day),
    'previous', public._team_digest_totals(p_day - 1),
    'week_ago', public._team_digest_totals(p_day - 7),
    'breakdowns', v_breakdowns,
    'pending', v_pending,
    'lists', v_lists);
END;
$$;

REVOKE ALL ON FUNCTION public._team_digest_totals(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._team_digest_totals(date) TO service_role;
REVOKE ALL ON FUNCTION public.team_daily_metrics(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_daily_metrics(date) TO service_role;

-- 3. Recipients, run log and opt-outs ------------------------------------------------------
-- Every active panel account with a provable address (00635: mailable_user_emails), minus the
-- platform account and whoever opted out. With team_digest_preview_to set, only that account; a
-- value that is no account's id sends to nobody.
CREATE OR REPLACE FUNCTION public.team_digest_recipients()
RETURNS TABLE (user_id uuid, role text, email text, full_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  c_platform CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  v_preview text := btrim(coalesce(public.get_platform_config_text('team_digest_preview_to', ''), ''));
BEGIN
  RETURN QUERY
  WITH staff AS (
    SELECT u.id, u.role::text AS role, coalesce(btrim(u.full_name), '') AS full_name
    FROM public.users u
    WHERE u.role IN ('super_admin', 'admin', 'marketing')
      AND coalesce(u.is_active, true)
      AND u.id <> c_platform
      AND NOT EXISTS (SELECT 1 FROM public.team_digest_optouts o WHERE o.user_id = u.id AND o.opted_out)
      AND (v_preview = '' OR u.id::text = v_preview)
  )
  SELECT s.id, s.role, m.email, s.full_name
  FROM staff s
  JOIN public.mailable_user_emails(ARRAY(SELECT s2.id FROM staff s2)) m ON m.user_id = s.id
  ORDER BY s.role, s.id;
END;
$$;

-- One winner per day. A send stuck in 'sending' for 30 minutes died; it becomes 'failed' and is
-- never claimed again: a retry could send it twice.
CREATE OR REPLACE FUNCTION public.claim_team_digest(p_day date)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'claim_team_digest: p_day is required' USING DETAIL = 'team_digest_bad_day';
  END IF;
  UPDATE public.team_digest_runs
     SET status = 'failed', finished_at = now(), last_error = coalesce(last_error, 'interrupted')
   WHERE status = 'sending' AND started_at < now() - interval '30 minutes';
  INSERT INTO public.team_digest_runs (day) VALUES (p_day) ON CONFLICT (day) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

-- The outcome, only while the day is still 'sending'. Nothing sent to anyone (with recipients or
-- with an error) is 'failed'; anything else is 'sent', with its failures counted.
CREATE OR REPLACE FUNCTION public.finish_team_digest(p_day date, p_recipients integer, p_sent integer, p_failed integer, p_error text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.team_digest_runs
     SET status = CASE WHEN coalesce(p_sent, 0) = 0 AND (coalesce(p_recipients, 0) > 0 OR p_error IS NOT NULL)
                       THEN 'failed' ELSE 'sent' END,
         finished_at = now(),
         recipients = coalesce(p_recipients, 0),
         sent = coalesce(p_sent, 0),
         failed = coalesce(p_failed, 0),
         last_error = left(p_error, 500)
   WHERE day = p_day AND status = 'sending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

-- p_out = true stops the digest for that account, false brings it back. false for an unknown id.
CREATE OR REPLACE FUNCTION public.set_team_digest_optout(p_user uuid, p_out boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user) THEN
    RETURN false;
  END IF;
  INSERT INTO public.team_digest_optouts (user_id, opted_out) VALUES (p_user, coalesce(p_out, true))
  ON CONFLICT (user_id) DO UPDATE SET opted_out = EXCLUDED.opted_out, updated_at = now();
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.team_digest_recipients() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.team_digest_recipients() TO service_role;
REVOKE ALL ON FUNCTION public.claim_team_digest(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_team_digest(date) TO service_role;
REVOKE ALL ON FUNCTION public.finish_team_digest(date, integer, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_team_digest(date, integer, integer, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.set_team_digest_optout(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_team_digest_optout(uuid, boolean) TO service_role;

-- 4. Dispatch and overdue check ------------------------------------------------------------
-- Hourly at :05. Between 7:00 and 8:59 Havana time, with the switch on and no run for the day
-- before, calls send-team-digest with that day. No EXCEPTION handler: a failure must reach
-- check_cron_sql_failures (00596). p_now exists for the rehearsal; the cron passes nothing.
CREATE OR REPLACE FUNCTION public.dispatch_team_digest(p_now timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_day date := (p_now AT TIME ZONE 'America/Havana')::date - 1;
  v_hour integer := extract(hour FROM (p_now AT TIME ZONE 'America/Havana'))::integer;
  v_key text;
BEGIN
  UPDATE public.team_digest_runs
     SET status = 'failed', finished_at = now(), last_error = coalesce(last_error, 'interrupted')
   WHERE status = 'sending' AND started_at < now() - interval '30 minutes';

  IF coalesce(public.get_platform_config_text('team_digest_enabled', 'false'), 'false') <> 'true' THEN
    RETURN 'disabled';
  END IF;
  IF v_hour < 7 OR v_hour >= 9 THEN
    RETURN 'not_now';
  END IF;
  IF EXISTS (SELECT 1 FROM public.team_digest_runs r WHERE r.day = v_day) THEN
    RETURN 'already';
  END IF;

  v_key := public.get_service_role_key();
  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'dispatch_team_digest: no service role key in the vault, the digest for % was not sent', v_day
      USING DETAIL = 'team_digest_no_service_key';
  END IF;
  PERFORM public.cron_http_post('send-team-digest',
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-team-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key,
      'apikey', v_key),
    body := jsonb_build_object('day', to_char(v_day, 'YYYY-MM-DD')),
    timeout_milliseconds := 30000);
  RETURN 'dispatched';
END;
$$;

-- Every 15 minutes. From 9:00 Havana time, with the switch on, fails while the day before is not
-- 'sent', so check_cron_sql_failures (00596) e-mails the business address. Its own job: a RAISE
-- inside dispatch_team_digest would also roll back its HTTP call. Turning the switch on after
-- 9:00 makes this fail once for that day, since nothing was dispatched.
CREATE OR REPLACE FUNCTION public.check_team_digest_overdue(p_now timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_day date := (p_now AT TIME ZONE 'America/Havana')::date - 1;
  v_hour integer := extract(hour FROM (p_now AT TIME ZONE 'America/Havana'))::integer;
  v_status text;
BEGIN
  IF coalesce(public.get_platform_config_text('team_digest_enabled', 'false'), 'false') <> 'true' THEN
    RETURN 'disabled';
  END IF;
  IF v_hour < 9 THEN
    RETURN 'not_yet';
  END IF;
  SELECT r.status INTO v_status FROM public.team_digest_runs r WHERE r.day = v_day;
  IF v_status IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'check_team_digest_overdue: the digest for % is %', v_day, coalesce(v_status, 'not sent')
      USING DETAIL = 'team_digest_overdue';
  END IF;
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_team_digest(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_team_digest(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.check_team_digest_overdue(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_team_digest_overdue(timestamptz) TO service_role;

-- cron.schedule updates an existing job's schedule and command but keeps its active flag: a job
-- that someone paused is switched back on.
DO $cron$
DECLARE
  v_job bigint;
BEGIN
  v_job := cron.schedule('send-team-digest', '5 * * * *', 'SELECT public.dispatch_team_digest();');
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_job AND NOT active) THEN
    PERFORM cron.alter_job(v_job, active := true);
  END IF;
  v_job := cron.schedule('check-team-digest-overdue', '*/15 * * * *', 'SELECT public.check_team_digest_overdue();');
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_job AND NOT active) THEN
    PERFORM cron.alter_job(v_job, active := true);
  END IF;
END $cron$;

-- 5. Pasted from Windows (CRLF), the bodies would carry \r: recreate them from the catalog without it.
DO $crlf$
DECLARE
  v_fn regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._team_digest_totals(date)', 'public.team_daily_metrics(date)', 'public.team_digest_recipients()',
    'public.claim_team_digest(date)', 'public.finish_team_digest(date, integer, integer, integer, text)',
    'public.set_team_digest_optout(uuid, boolean)', 'public.dispatch_team_digest(timestamptz)',
    'public.check_team_digest_overdue(timestamptz)']::regprocedure[]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END $crlf$;

-- 6. Self-checks ---------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn regprocedure;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._team_digest_totals(date)', 'public.team_daily_metrics(date)', 'public.team_digest_recipients()',
    'public.claim_team_digest(date)', 'public.finish_team_digest(date, integer, integer, integer, text)',
    'public.set_team_digest_optout(uuid, boolean)', 'public.dispatch_team_digest(timestamptz)',
    'public.check_team_digest_overdue(timestamptz)']::regprocedure[]
  LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00656: % is executable by a client role', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00656: service_role cannot execute %', v_fn;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) THEN
      RAISE EXCEPTION '00656: % must be SECURITY DEFINER', v_fn;
    END IF;
    IF (SELECT position(chr(13) IN p.prosrc) FROM pg_proc p WHERE p.oid = v_fn) > 0 THEN
      RAISE EXCEPTION '00656: % kept a carriage return', v_fn;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.team_digest_runs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.team_digest_runs', 'SELECT')
     OR has_table_privilege('anon', 'public.team_digest_optouts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.team_digest_optouts', 'SELECT') THEN
    RAISE EXCEPTION '00656: a client role can read the digest tables';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-team-digest' AND schedule = '5 * * * *'
                   AND command = 'SELECT public.dispatch_team_digest();' AND active)
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-team-digest-overdue' AND schedule = '*/15 * * * *'
                      AND command = 'SELECT public.check_team_digest_overdue();' AND active) THEN
    RAISE EXCEPTION '00656: a team digest cron job is missing or inactive';
  END IF;
  IF (SELECT count(*) FROM public.platform_config WHERE key IN ('team_digest_enabled', 'team_digest_preview_to')) <> 2 THEN
    RAISE EXCEPTION '00656: the team digest settings are missing';
  END IF;
END $check$;

RESET lock_timeout;
