-- Scaffold for the 00670 rehearsal (supabase/tests/00670/run.sh).
-- The 20 functions are the LIVE prod bodies (pg_get_functiondef, 2026-11-01), verbatim.
-- Tables carry only what the function definitions and the wait-charge test need.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END
$roles$;
GRANT USAGE, CREATE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
SET SESSION AUTHORIZATION postgres;

CREATE TABLE public.rides (id uuid PRIMARY KEY, service_type text, estimated_fare_cup integer);
CREATE TABLE public.service_type_configs (
  slug text PRIMARY KEY, is_active boolean DEFAULT true,
  free_wait_minutes integer, per_wait_minute_rate_cup integer
);
CREATE TABLE public.pricing_rules (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, service_type text, is_active boolean DEFAULT true,
  per_wait_minute_rate_cup integer, time_window_start time, time_window_end time, day_of_week integer[]
);
-- No PostGIS here: create_rides_for_recurring declares geography variables, and only
-- the declaration is resolved when the function is created.
CREATE DOMAIN public.geography AS text;
CREATE FUNCTION public.get_platform_config_numeric(p_key text, p_default numeric) RETURNS numeric
LANGUAGE sql STABLE AS $f$ SELECT p_default $f$;

CREATE OR REPLACE FUNCTION public._team_digest_totals(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_platform CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  v_start timestamptz := (p_day::timestamp AT TIME ZONE 'America/Havana');
  v_end   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'America/Havana');
  v_hours integer;
  v_rides jsonb;
  v_drivers_with_ride integer;
  v_charged bigint;
  v_commission bigint;
  v_first_rides integer;
  v_signups jsonb;
  v_money jsonb;
  v_marketing jsonb;
  v_online integer;
  v_covered integer;
BEGIN
  IF p_day IS NULL THEN
    RAISE EXCEPTION '_team_digest_totals: p_day is required' USING DETAIL = 'team_digest_bad_day';
  END IF;
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

  -- Every ride number reads this one set of real rides requested or completed that day.
  WITH real_rides AS (
    SELECT r.id, r.status, r.driver_id, r.canceled_by, r.customer_id, r.created_at, r.completed_at,
           r.final_fare_cup, dp.user_id AS driver_user_id, coalesce(du.is_test, false) AS driver_is_test
    FROM public.rides r
    JOIN public.users cu ON cu.id = r.customer_id
    LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
    LEFT JOIN public.users du ON du.id = dp.user_id
    WHERE NOT cu.is_test AND cu.id <> c_platform
      AND ((r.created_at >= v_start AND r.created_at < v_end)
           OR (r.completed_at >= v_start AND r.completed_at < v_end))
  ),
  requested AS (
    SELECT rr.* FROM real_rides rr WHERE rr.created_at >= v_start AND rr.created_at < v_end
  ),
  completed AS (
    SELECT rr.* FROM real_rides rr
    WHERE rr.status = 'completed' AND rr.completed_at >= v_start AND rr.completed_at < v_end
  )
  SELECT
    (SELECT jsonb_build_object(
       'requested', count(*),
       'completed', count(*) FILTER (WHERE q.status = 'completed'),
       'canceled_by_rider', count(*) FILTER (WHERE q.status = 'canceled' AND q.driver_id IS NOT NULL
                                               AND q.canceled_by = q.customer_id),
       'canceled_by_driver', count(*) FILTER (WHERE q.status = 'canceled' AND q.driver_id IS NOT NULL
                                                AND q.canceled_by = q.driver_user_id),
       'no_driver', count(*) FILTER (WHERE q.status = 'canceled' AND q.driver_id IS NULL),
       'no_driver_with_offer', count(*) FILTER (WHERE q.status = 'canceled' AND q.driver_id IS NULL
                                                  AND EXISTS (SELECT 1 FROM public.ride_offers o WHERE o.ride_id = q.id)),
       'no_driver_without_offer', count(*) FILTER (WHERE q.status = 'canceled' AND q.driver_id IS NULL
                                                     AND NOT EXISTS (SELECT 1 FROM public.ride_offers o WHERE o.ride_id = q.id)))
     FROM requested q),
    (SELECT count(DISTINCT c.driver_id) FROM completed c WHERE NOT c.driver_is_test),
    (SELECT coalesce(sum(c.final_fare_cup), 0) FROM completed c),
    (SELECT coalesce(sum(s.commission_amount), 0) FROM public.ride_pricing_snapshots s
     JOIN completed c ON c.id = s.ride_id WHERE s.snapshot_type = 'final'),
    -- A first ride: no earlier ride of that customer finished before the day, whatever its status
    -- is now (a ride disputed later still happened).
    (SELECT count(DISTINCT c.customer_id) FROM completed c
     WHERE NOT EXISTS (SELECT 1 FROM public.rides p
                       WHERE p.customer_id = c.customer_id AND p.completed_at < v_start))
  INTO v_rides, v_drivers_with_ride, v_charged, v_commission, v_first_rides;

  -- Hour buckets in UTC (the three-argument date_trunc), so the count does not depend on the
  -- session time zone. Havana's offsets are whole hours, so a UTC hour is a Havana hour.
  SELECT count(DISTINCT h.driver_profile_id), count(DISTINCT date_trunc('hour', h.beat_at, 'UTC'))
    INTO v_online, v_covered
  FROM public.driver_heartbeat_log h
  JOIN public.driver_profiles dp ON dp.id = h.driver_profile_id
  JOIN public.users hu ON hu.id = dp.user_id AND NOT hu.is_test
  WHERE h.is_online AND h.beat_at >= v_start AND h.beat_at < v_end;
  v_rides := v_rides || jsonb_build_object('hours_without_coverage', v_hours - v_covered);

  SELECT jsonb_build_object(
    'new_riders', (SELECT count(*) FROM public.users u
                   WHERE u.created_at >= v_start AND u.created_at < v_end AND NOT u.is_test AND u.id <> c_platform
                     AND NOT EXISTS (SELECT 1 FROM public.driver_profiles dp WHERE dp.user_id = u.id)),
    'drivers_registered', (SELECT count(*) FROM public.driver_profiles dp
                           JOIN public.users ru ON ru.id = dp.user_id AND NOT ru.is_test
                           WHERE dp.created_at >= v_start AND dp.created_at < v_end),
    'drivers_approved', (SELECT count(*) FROM public.driver_profiles dp
                         JOIN public.users au ON au.id = dp.user_id AND NOT au.is_test
                         WHERE dp.approved_at >= v_start AND dp.approved_at < v_end),
    'drivers_online', v_online,
    'drivers_with_ride', v_drivers_with_ride
  ) INTO v_signups;

  v_money := jsonb_build_object(
    'charged', v_charged,
    'commission', v_commission,
    'recharged', coalesce((SELECT sum(pi.amount_cup) FROM public.payment_intents pi
                           LEFT JOIN public.users u ON u.id = pi.user_id
                           WHERE pi.status = 'completed' AND pi.paid_at >= v_start AND pi.paid_at < v_end
                             AND NOT coalesce(u.is_test, false)), 0)::bigint);

  SELECT jsonb_build_object(
    'signups_with_code', (SELECT count(*) FROM public.users u
                          WHERE u.created_at >= v_start AND u.created_at < v_end AND NOT u.is_test
                            AND u.signup_code IS NOT NULL),
    'referrals', (SELECT count(*) FROM public.referrals rf
                  WHERE rf.created_at >= v_start AND rf.created_at < v_end
                    AND NOT EXISTS (SELECT 1 FROM public.users tu
                                    WHERE tu.id IN (rf.referee_id, rf.referrer_id) AND tu.is_test)),
    'first_rides', v_first_rides,
    'campaigns_sent', (SELECT count(*) FROM public.campaigns c
                       WHERE c.status = 'sent' AND c.sent_at >= v_start AND c.sent_at < v_end),
    'promotion_uses', (SELECT count(*) FROM public.promotion_uses pu
                       WHERE pu.created_at >= v_start AND pu.created_at < v_end
                         AND NOT EXISTS (SELECT 1 FROM public.users pu_u WHERE pu_u.id = pu.user_id AND pu_u.is_test))
  ) INTO v_marketing;

  RETURN jsonb_build_object('rides', v_rides, 'signups', v_signups, 'money', v_money, 'marketing', v_marketing);
END;
$function$;

CREATE OR REPLACE FUNCTION public._wait_charge_for(p_service_type text, p_arrived_at timestamp with time zone, p_pickup_at timestamp with time zone, OUT wait_minutes integer, OUT billable_minutes integer, OUT charge integer)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_svc public.service_type_configs%ROWTYPE;
  v_wait_seconds numeric;
  v_max_billable integer;
  v_band_rate integer;
  v_at_t time;
  v_at_dow int;
BEGIN
  IF p_arrived_at IS NULL OR p_pickup_at IS NULL THEN
    wait_minutes := 0; billable_minutes := 0; charge := 0;
    RETURN;
  END IF;
  SELECT * INTO v_svc FROM public.service_type_configs WHERE slug = p_service_type;
  v_wait_seconds := EXTRACT(EPOCH FROM (p_pickup_at - p_arrived_at));
  wait_minutes := GREATEST(0, FLOOR(v_wait_seconds / 60)::integer);
  billable_minutes := GREATEST(0, wait_minutes - COALESCE(v_svc.free_wait_minutes, 5));
  v_max_billable := GREATEST(0, public.get_platform_config_numeric('max_billable_wait_minutes', 20)::integer);
  billable_minutes := LEAST(billable_minutes, v_max_billable);

  -- 00502: the rate of the band the wait STARTED in (Havana time).
  BEGIN
    v_at_t   := (p_arrived_at AT TIME ZONE 'America/Havana')::time;
    v_at_dow := EXTRACT(dow FROM (p_arrived_at AT TIME ZONE 'America/Havana'))::int;
    SELECT pr.per_wait_minute_rate_cup INTO v_band_rate
    FROM public.pricing_rules pr
    WHERE pr.service_type = p_service_type
      AND pr.is_active = true
      AND pr.per_wait_minute_rate_cup IS NOT NULL
      AND (pr.time_window_start IS NULL OR pr.time_window_end IS NULL OR
           CASE WHEN pr.time_window_start <= pr.time_window_end
                THEN v_at_t >= pr.time_window_start AND v_at_t < pr.time_window_end
                ELSE v_at_t >= pr.time_window_start OR v_at_t < pr.time_window_end END)
      AND (pr.day_of_week IS NULL OR array_length(pr.day_of_week, 1) IS NULL
           OR v_at_dow = ANY(pr.day_of_week))
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_band_rate := NULL;
  END;

  charge := billable_minutes * COALESCE(v_band_rate, v_svc.per_wait_minute_rate_cup, 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public._write_ride_estimate_snapshot(p_ride rides, p_replace boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_svc                  RECORD;
  v_commission_rate      NUMERIC;
  v_corp_commission_rate NUMERIC;
  v_eff_per_km           INTEGER;
  v_commission_amount    INTEGER;
  v_rule_id              uuid;
  v_now_t                time;
  v_now_dow              int;
  v_exists               boolean;
BEGIN
  IF p_ride.estimated_fare_cup IS NULL OR p_ride.estimated_fare_cup <= 0 THEN
    RETURN;
  END IF;

  v_exists := EXISTS (
    SELECT 1 FROM public.ride_pricing_snapshots
    WHERE ride_id = p_ride.id AND snapshot_type = 'estimate'
  );
  IF v_exists AND NOT p_replace THEN
    RETURN;
  END IF;

  SELECT * INTO v_svc
  FROM public.service_type_configs
  WHERE slug = p_ride.service_type AND is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  BEGIN
    v_now_t   := (now() AT TIME ZONE 'America/Havana')::time;
    v_now_dow := EXTRACT(dow FROM now() AT TIME ZONE 'America/Havana')::int;
    SELECT pr.id INTO v_rule_id
    FROM public.pricing_rules pr
    WHERE pr.service_type = p_ride.service_type
      AND pr.is_active = true
      AND (pr.time_window_start IS NULL OR pr.time_window_end IS NULL OR
           CASE WHEN pr.time_window_start <= pr.time_window_end
                THEN v_now_t >= pr.time_window_start AND v_now_t < pr.time_window_end
                ELSE v_now_t >= pr.time_window_start OR v_now_t < pr.time_window_end END)
      AND (pr.day_of_week IS NULL OR array_length(pr.day_of_week, 1) IS NULL
           OR v_now_dow = ANY(pr.day_of_week))
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_rule_id := NULL;
  END;

  v_eff_per_km := COALESCE(p_ride.driver_custom_rate_cup, v_svc.per_km_rate_cup);

  SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
  FROM public.platform_config WHERE key = 'commission_rate';
  -- Guard: 0 / NULL / out-of-range (>=1) is invalid -> fall back to 15%.
  IF v_commission_rate IS NULL OR v_commission_rate <= 0 OR v_commission_rate >= 1 THEN
    v_commission_rate := 0.15;
  END IF;

  IF p_ride.corporate_account_id IS NOT NULL THEN
    SELECT commission_percent / 100.0 INTO v_corp_commission_rate
    FROM public.corporate_accounts WHERE id = p_ride.corporate_account_id;
  END IF;

  IF v_corp_commission_rate IS NOT NULL AND v_corp_commission_rate < v_commission_rate THEN
    v_commission_amount := ROUND(p_ride.estimated_fare_cup * v_corp_commission_rate)::int;
  ELSE
    v_commission_amount := ROUND(p_ride.estimated_fare_cup * v_commission_rate)::int;
  END IF;

  IF v_exists THEN
    UPDATE public.ride_pricing_snapshots SET (
      base_fare, per_km_rate, per_minute_rate,
      distance_m, duration_s, surge_multiplier, subtotal,
      commission_rate, commission_amount, total, pricing_rule_id,
      exchange_rate_usd_cup, total_trc,
      min_fare, corporate_commission_rate, default_commission_rate_snapshot
    ) = (
      v_svc.base_fare_cup, v_eff_per_km, v_svc.per_minute_rate_cup,
      p_ride.estimated_distance_m, p_ride.estimated_duration_s, p_ride.surge_multiplier,
      p_ride.estimated_fare_cup,
      COALESCE(v_corp_commission_rate, v_commission_rate),
      v_commission_amount,
      p_ride.estimated_fare_cup,
      v_rule_id,
      p_ride.exchange_rate_usd_cup, p_ride.estimated_fare_trc,
      v_svc.min_fare_cup, v_corp_commission_rate, v_commission_rate
    )
    WHERE ride_id = p_ride.id AND snapshot_type = 'estimate';
  ELSE
    INSERT INTO public.ride_pricing_snapshots (
      ride_id, snapshot_type, base_fare, per_km_rate, per_minute_rate,
      distance_m, duration_s, surge_multiplier, subtotal,
      commission_rate, commission_amount, total, pricing_rule_id,
      exchange_rate_usd_cup, total_trc,
      min_fare, corporate_commission_rate, default_commission_rate_snapshot
    ) VALUES (
      p_ride.id, 'estimate',
      v_svc.base_fare_cup, v_eff_per_km, v_svc.per_minute_rate_cup,
      p_ride.estimated_distance_m, p_ride.estimated_duration_s, p_ride.surge_multiplier,
      p_ride.estimated_fare_cup,
      COALESCE(v_corp_commission_rate, v_commission_rate),
      v_commission_amount,
      p_ride.estimated_fare_cup,
      v_rule_id,
      p_ride.exchange_rate_usd_cup, p_ride.estimated_fare_trc,
      v_svc.min_fare_cup, v_corp_commission_rate, v_commission_rate
    );
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_deliveries_by_day(p_days integer DEFAULT 30)
 RETURNS TABLE(day date, total integer, completed integer, canceled integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin','super_admin')) THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;
  RETURN QUERY
  SELECT (date_trunc('day', r.created_at AT TIME ZONE 'America/Havana'))::date,
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE r.status = 'completed')::integer,
    COUNT(*) FILTER (WHERE r.status IN ('canceled','failed','no_driver_found'))::integer
  FROM rides r WHERE r.ride_mode = 'cargo' AND r.created_at >= NOW() - (p_days || ' days')::interval
  GROUP BY 1 ORDER BY 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_launch_pulse(p_weeks integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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
  IF NOT (public.is_admin() OR public.is_marketing() OR public.is_operator()) THEN
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

CREATE OR REPLACE FUNCTION public.check_cron_sql_failures()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_found      jsonb;  -- failing right now, with details
  v_candidates jsonb;  -- their names: this check's sighting
  v_prev_cand  jsonb;  -- the previous check's sighting
  v_signature  jsonb;  -- names seen at both checks: the confirmed set, the de-dup key
  v_prev       jsonb;  -- the confirmed set of the last email
  v_status     text;
  v_detail     text;
  v_recovered  text;
  v_item       jsonb;
  v_rows       text := '';
  v_subject    text;
  v_html       text;
  v_sent       integer := 0;
BEGIN
  v_found := cron_sql_failures_now();
  SELECT COALESCE(jsonb_agg(e ->> 'job' ORDER BY e ->> 'job'), '[]'::jsonb)
    INTO v_candidates
  FROM jsonb_array_elements(v_found) AS e;

  SELECT CASE WHEN jsonb_typeof(value) = 'array' THEN value END INTO v_prev_cand
  FROM platform_config WHERE key = 'cron_sql_health_candidates';
  SELECT CASE WHEN jsonb_typeof(value) = 'array' THEN value END INTO v_prev
  FROM platform_config WHERE key = 'cron_sql_health_signature';
  v_prev_cand := COALESCE(v_prev_cand, '[]'::jsonb);
  v_prev      := COALESCE(v_prev, '[]'::jsonb);

  SELECT COALESCE(jsonb_agg(c.name ORDER BY c.name), '[]'::jsonb)
    INTO v_signature
  FROM jsonb_array_elements_text(v_candidates) AS c(name)
  WHERE v_prev_cand ? c.name;

  v_status := CASE WHEN jsonb_array_length(v_signature) > 0 THEN 'failing' ELSE 'ok' END;

  SELECT string_agg((e ->> 'job') || ': '
                    || CASE WHEN e ->> 'failures' = '1' THEN '1 falla' ELSE (e ->> 'failures') || ' fallas seguidas' END,
                    ' · ' ORDER BY e ->> 'job')
    INTO v_detail
  FROM jsonb_array_elements(v_found) AS e
  WHERE v_signature ? (e ->> 'job');
  v_detail := COALESCE(v_detail, 'todas las tareas programadas andan');
  IF jsonb_array_length(v_candidates) > jsonb_array_length(v_signature) THEN
    v_detail := v_detail || ' · en observación: '
      || (SELECT string_agg(c.name, ', ' ORDER BY c.name)
          FROM jsonb_array_elements_text(v_candidates) AS c(name)
          WHERE NOT (v_signature ? c.name));
  END IF;

  INSERT INTO platform_config (key, value) VALUES
    ('cron_sql_health_status',     to_jsonb(v_status)),
    ('cron_sql_health_signature',  v_signature),
    ('cron_sql_health_candidates', v_candidates),
    ('cron_sql_health_detail',     to_jsonb(v_detail)),
    ('cron_sql_health_at',         to_jsonb(now()::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  IF v_signature IS DISTINCT FROM v_prev THEN
    SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO v_recovered
    FROM jsonb_array_elements_text(v_prev) AS r(name)
    WHERE NOT (v_signature ? r.name);

    IF v_status = 'failing' THEN
      FOR v_item IN
        SELECT e FROM jsonb_array_elements(v_found) AS e
        WHERE v_signature ? (e ->> 'job') ORDER BY e ->> 'job'
      LOOP
        v_rows := v_rows
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>'
          || replace(replace(replace(COALESCE(v_item ->> 'job', '?'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
          || '</b><br><span style="color:#666;font-size:12px">'
          || replace(replace(replace(COALESCE(v_item ->> 'schedule', ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
          || '</span></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">'
          || CASE WHEN v_item ->> 'failures' = '1' THEN '1 falla'
                  ELSE COALESCE(v_item ->> 'failures', '?') || ' fallas seguidas' END
          || '<br><span style="color:#666;font-size:12px">desde el '
          || COALESCE(to_char((v_item ->> 'since')::timestamptz AT TIME ZONE 'America/Havana', 'DD/MM HH24:MI'), '?')
          || '</span></td></tr>'
          || '<tr><td colspan="2" style="padding:4px 6px;color:#666;font-size:12px">'
          || COALESCE('Última vez que anduvo: '
                      || to_char((v_item ->> 'last_ok')::timestamptz AT TIME ZONE 'America/Havana', 'DD/MM HH24:MI'),
                      'No anduvo ni una vez en los últimos 14 días')
          || '</td></tr>'
          || '<tr><td colspan="2" style="padding:4px 6px 12px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px;color:#b91c1c">'
          -- Escape first, then turn the ERROR / HINT / CONTEXT lines into <br>.
          || replace(btrim(replace(replace(replace(COALESCE(v_item ->> 'error', ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), E'\n'),
                     E'\n', '<br>')
          || '</td></tr>';
      END LOOP;

      v_subject := CASE WHEN jsonb_array_length(v_signature) = 1
                        THEN '[TriciGo] Tarea programada fallando: ' || (v_signature ->> 0)
                        ELSE '[TriciGo] ' || jsonb_array_length(v_signature) || ' tareas programadas fallando' END;
      v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#111">'
        || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">Tareas programadas de la base fallando</h2>'
        || '<p>Estas tareas automáticas de la base fallaron varias veces seguidas con un error propio, '
        || 'no por una caída de Supabase. Mientras sigan así, lo que hacen no se hace.</p>'
        || '<table style="width:100%;border-collapse:collapse;margin:16px 0">' || v_rows || '</table>'
        || COALESCE('<p>Ya se recuperaron: '
                    || replace(replace(replace(v_recovered, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '.</p>', '')
        || '<p><b>Qué revisar:</b> el error de cada tarea. Historial completo: '
        || '<code>SELECT start_time, status, return_message FROM cron.job_run_details '
        || 'WHERE jobid = &lt;jobid&gt; ORDER BY start_time DESC LIMIT 20;</code> '
        || 'Lo que falla ahora: <code>SELECT public.cron_sql_failures_now();</code></p>'
        || '<p style="color:#777;font-size:12px">Horas de Cuba. Llega un correo cuando cambia la lista de tareas que fallan: '
        || 'si una sigue fallando, no se repite. Aviso automático de tareas programadas. No responder.</p></body></html>';
    ELSE
      v_subject := '[TriciGo] Tareas programadas de la base recuperadas';
      v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#111">'
        || '<h2 style="color:#16a34a;border-bottom:2px solid #16a34a;padding-bottom:8px">Tareas programadas recuperadas</h2>'
        || '<p>Todas las tareas programadas de la base vuelven a andar.</p>'
        || '<p style="color:#777;font-size:12px">Estaban fallando: '
        || replace(replace(replace(COALESCE(v_recovered, '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '.</p>'
        || '<p style="color:#777;font-size:12px">Aviso automático de tareas programadas. No responder.</p></body></html>';
    END IF;

    -- 00597: every address in business_notification_email gets its email
    -- through cron_http_post, so a send that send-email rejects shows up in
    -- check_cron_http_failures. Same guards as send_db_health_email, which this
    -- used to call: no recipients, no email; a blank body is refused.
    DECLARE
      v_to_raw      text;
      v_rcpt        text;
      v_service_key text;
      v_headers     jsonb;
    BEGIN
      SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'business_notification_email';
      IF v_to_raw IS NULL OR position('@' IN v_to_raw) = 0 THEN
        NULL;
      ELSIF v_html IS NULL OR btrim(v_html) = '' OR v_subject IS NULL THEN
        RAISE WARNING 'check_cron_sql_failures: cuerpo vacío, no se envía (subject=%)', v_subject;
      ELSE
        v_service_key := get_service_role_key();
        v_headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key,
          'apikey', v_service_key);
        FOR v_rcpt IN
          SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x) WHERE position('@' IN x) > 0
        LOOP
          PERFORM public.cron_http_post('cron-sql-failure-alert',
            url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
            headers := v_headers,
            body    := jsonb_build_object('recipient_email', v_rcpt, 'subject', v_subject,
                                          -- Raw HTML, accepted by send-email's legacy path.
                                          'template', v_html, 'data', '{}'::jsonb));
          v_sent := v_sent + 1;
        END LOOP;
      END IF;
    END;
  END IF;

  RETURN jsonb_build_object('status', v_status, 'failing', v_signature, 'candidates', v_candidates,
                            'previous', v_prev, 'recovered', v_recovered, 'emails_sent', v_sent);
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_team_digest_overdue(p_now timestamp with time zone DEFAULT now())
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
  IF v_status IS NULL AND coalesce(public.get_service_role_key(), '') = '' THEN
    RAISE EXCEPTION 'check_team_digest_overdue: the digest for % is not sent: no service role key in the vault', v_day
      USING DETAIL = 'team_digest_overdue';
  END IF;
  IF v_status IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'check_team_digest_overdue: the digest for % is %', v_day, coalesce(v_status, 'not sent')
      USING DETAIL = 'team_digest_overdue';
  END IF;
  RETURN 'ok';
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_rides_for_recurring()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_rec RECORD;
  v_count INT := 0;
  v_next TIMESTAMPTZ;
  v_pickup GEOGRAPHY;
  v_dropoff GEOGRAPHY;
BEGIN
  -- 00655: the apps hide recurring rides unless this flag is on, and the rides
  -- this creates have no price yet. Off (or missing), nothing is created.
  IF NOT COALESCE((SELECT f.value FROM public.feature_flags f
                    WHERE f.key = 'recurring_rides_enabled'), false) THEN
    RETURN 0;
  END IF;
  FOR v_rec IN
    SELECT * FROM recurring_rides
    WHERE status = 'active'
      AND next_occurrence_at IS NOT NULL
      AND next_occurrence_at <= NOW() + interval '24 hours'
      AND (last_triggered_at IS NULL
           OR last_triggered_at < next_occurrence_at - interval '25 hours')
  LOOP
    BEGIN
      v_pickup  := ST_SetSRID(ST_MakePoint(v_rec.pickup_longitude::float8,  v_rec.pickup_latitude::float8),  4326)::geography;
      v_dropoff := ST_SetSRID(ST_MakePoint(v_rec.dropoff_longitude::float8, v_rec.dropoff_latitude::float8), 4326)::geography;

      INSERT INTO rides (
        customer_id, service_type, payment_method,
        pickup_location, pickup_address, pickup_lat, pickup_lng,
        dropoff_location, dropoff_address, dropoff_lat, dropoff_lng,
        estimated_fare_cup, estimated_distance_m, estimated_duration_s,
        is_scheduled, scheduled_at, status
      ) VALUES (
        v_rec.customer_id, v_rec.service_type, v_rec.payment_method::payment_method,
        v_pickup, v_rec.pickup_address, v_rec.pickup_latitude::float8, v_rec.pickup_longitude::float8,
        v_dropoff, v_rec.dropoff_address, v_rec.dropoff_latitude::float8, v_rec.dropoff_longitude::float8,
        0, 0, 0, true, v_rec.next_occurrence_at, 'searching'
      );

      v_next := compute_next_occurrence(
        v_rec.days_of_week::smallint[],
        v_rec.time_of_day,
        'America/Havana'::text,
        v_rec.next_occurrence_at + interval '1 hour'
      );

      UPDATE recurring_rides
        SET last_triggered_at = NOW(),
            next_occurrence_at = v_next,
            updated_at = NOW()
      WHERE id = v_rec.id;

      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'create_rides_for_recurring: skipped recurring % : % %', v_rec.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dispatch_team_digest(p_now timestamp with time zone DEFAULT now())
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_dashboard_metrics()
 RETURNS TABLE(active_rides bigint, total_rides_today bigint, online_drivers bigint, total_revenue_today bigint, pending_verifications bigint, open_incidents bigint, searching_rides bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Havana')::date;
  v_day_start timestamptz := (v_today::timestamp AT TIME ZONE 'America/Havana');
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing() OR public.is_operator()) THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM rides
     WHERE status IN ('searching','accepted','driver_en_route','arrived_at_pickup','in_progress'))
      AS active_rides,
    (SELECT COUNT(*) FROM rides
     WHERE created_at >= v_day_start)
      AS total_rides_today,
    (SELECT COUNT(*) FROM driver_profiles
     WHERE is_online = true)
      AS online_drivers,
    (SELECT COALESCE(SUM(final_fare_cup), 0) FROM rides
     WHERE status = 'completed' AND completed_at >= v_day_start)
      AS total_revenue_today,
    (SELECT COUNT(*) FROM driver_profiles
     WHERE status IN ('pending_verification','under_review'))
      AS pending_verifications,
    (SELECT COUNT(*) FROM incident_reports
     WHERE status IN ('open','investigating'))
      AS open_incidents,
    (SELECT COUNT(*) FROM rides
     WHERE status = 'searching')
      AS searching_rides;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_destination_suggestions(p_user_id uuid, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_hour integer DEFAULT NULL::integer, p_limit integer DEFAULT 5)
 RETURNS TABLE(address text, latitude double precision, longitude double precision, score double precision, reason text, source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_hour  int := COALESCE(p_hour, EXTRACT(hour FROM now() AT TIME ZONE 'America/Havana')::int);
  v_dow   int := EXTRACT(dow  FROM now() AT TIME ZONE 'America/Havana')::int;
  v_limit int := GREATEST(LEAST(COALESCE(p_limit, 5), 10), 1);
BEGIN
  IF p_user_id IS NULL OR NOT (COALESCE(auth.uid() = p_user_id, false) OR public.is_admin()) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH personal_cells AS (
    SELECT
      count(*)                                                    AS frequency,
      count(*) FILTER (
        WHERE EXTRACT(hour FROM r.created_at AT TIME ZONE 'America/Havana')::int = v_hour
      )                                                           AS hour_count,
      count(*) FILTER (
        WHERE EXTRACT(dow FROM r.created_at AT TIME ZONE 'America/Havana')::int = v_dow
      )                                                           AS day_count,
      max(r.created_at)                                           AS last_visited,
      avg(r.dropoff_lat)                                          AS lat,
      avg(r.dropoff_lng)                                          AS lng,
      (array_agg(r.dropoff_address ORDER BY
        (r.dropoff_address ~ '\d' OR r.dropoff_address LIKE '% e/ %') DESC,
        r.created_at DESC))[1]                                    AS addr
    FROM public.rides r
    WHERE r.customer_id = p_user_id
      AND r.status = 'completed'
      AND r.dropoff_lat IS NOT NULL
      AND r.dropoff_lng IS NOT NULL
      AND r.dropoff_address IS NOT NULL
    GROUP BY round(r.dropoff_lat::numeric, 3), round(r.dropoff_lng::numeric, 3)
  ),
  personal_top AS (
    SELECT
      pc.addr AS address,
      pc.lat,
      pc.lng,
      (pc.frequency * 2 + pc.hour_count * 5 + pc.day_count * 3
        + CASE WHEN pc.last_visited >= now() - interval '7 days'  THEN 3
               WHEN pc.last_visited >= now() - interval '30 days' THEN 1
               ELSE 0 END)::double precision AS score,
      CASE WHEN pc.day_count >= 2 AND pc.hour_count >= 2 THEN 'time_pattern'
           WHEN pc.hour_count >= 2                       THEN 'time_pattern'
           WHEN pc.frequency  >= 3                       THEN 'frequent'
           ELSE 'recent' END AS reason,
      'personal'::text AS source
    FROM personal_cells pc
    WHERE (pc.addr ~ '\d' OR pc.addr LIKE '% e/ %'
           OR (length(pc.addr) - length(replace(pc.addr, ',', ''))) >= 2)
      AND (pc.frequency * 2 + pc.hour_count * 5 + pc.day_count * 3
        + CASE WHEN pc.last_visited >= now() - interval '7 days'  THEN 3
               WHEN pc.last_visited >= now() - interval '30 days' THEN 1
               ELSE 0 END) >= 3
    ORDER BY score DESC
    LIMIT v_limit
  ),
  popular_top AS (
    SELECT
      pc.addr AS address,
      pc.lat,
      pc.lng,
      pc.frequency::double precision AS score,
      'popular'::text AS reason,
      'popular'::text AS source
    FROM (
      SELECT
        (array_agg(r.dropoff_address ORDER BY
          (r.dropoff_address ~ '\d' OR r.dropoff_address LIKE '% e/ %') DESC,
          r.created_at DESC))[1] AS addr,
        avg(r.dropoff_lat) AS lat,
        avg(r.dropoff_lng) AS lng,
        count(*)           AS frequency
      FROM public.rides r
      WHERE r.status = 'completed'
        AND r.created_at >= now() - interval '90 days'
        AND r.dropoff_lat IS NOT NULL
        AND r.dropoff_lng IS NOT NULL
        AND r.dropoff_address IS NOT NULL
        AND (
          p_lat IS NULL OR p_lng IS NULL
          OR ST_DWithin(
               r.dropoff_location,
               ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
               15000
             )
        )
      GROUP BY round(r.dropoff_lat::numeric, 3), round(r.dropoff_lng::numeric, 3)
      HAVING count(DISTINCT r.customer_id) >= 3
    ) pc
    WHERE (pc.addr ~ '\d' OR pc.addr LIKE '% e/ %'
           OR (length(pc.addr) - length(replace(pc.addr, ',', ''))) >= 2)
      AND NOT EXISTS (
        SELECT 1 FROM personal_top pt
        WHERE abs(pt.lat - pc.lat) < 0.0015
          AND abs(pt.lng - pc.lng) < 0.0015
      )
    ORDER BY pc.frequency DESC
    LIMIT v_limit
  )
  SELECT s.address, s.lat AS latitude, s.lng AS longitude, s.score, s.reason, s.source
  FROM (
    SELECT pt.address, pt.lat, pt.lng, pt.score, pt.reason, pt.source, 0 AS tier FROM personal_top pt
    UNION ALL
    SELECT pp.address, pp.lat, pp.lng, pp.score, pp.reason, pp.source, 1 AS tier FROM popular_top pp
  ) s
  ORDER BY s.tier, s.score DESC
  LIMIT v_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_peak_hours(p_days_back integer DEFAULT 30)
 RETURNS TABLE(hour integer, avg_rides numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing() OR public.is_operator()) THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH hourly AS (
    SELECT EXTRACT(HOUR FROM r.created_at AT TIME ZONE 'America/Havana')::INT AS hour,
           (r.created_at AT TIME ZONE 'America/Havana')::DATE AS day,
           COUNT(*) AS rides
    FROM rides r
    WHERE r.created_at >= ((((now() AT TIME ZONE 'America/Havana')::date - p_days_back)::timestamp) AT TIME ZONE 'America/Havana')
    GROUP BY 1, 2
  )
  SELECT h.hour, ROUND(AVG(h.rides), 1) AS avg_rides FROM hourly h GROUP BY h.hour ORDER BY h.hour;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_platform_earnings()
 RETURNS TABLE(platform_balance bigint, earnings_today bigint, earnings_this_week bigint, earnings_this_month bigint, commission_rate numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Havana')::date;
  v_day_start timestamptz := (v_today::timestamp AT TIME ZONE 'America/Havana');
  v_week_start timestamptz := ((v_today - 7)::timestamp AT TIME ZONE 'America/Havana');
  v_month_start timestamptz := (date_trunc('month', v_today::timestamp) AT TIME ZONE 'America/Havana');
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT
    COALESCE((
      SELECT wa.balance FROM wallet_accounts wa
      WHERE wa.user_id = '00000000-0000-0000-0000-000000000001'
      AND wa.account_type = 'platform_revenue'
    ), 0)::BIGINT AS platform_balance,

    COALESCE((
      SELECT SUM(rps.commission_amount)
      FROM ride_pricing_snapshots rps
      JOIN rides r ON r.id = rps.ride_id
      WHERE r.status = 'completed'
      AND rps.snapshot_type = 'final'
      AND r.completed_at >= v_day_start
    ), 0)::BIGINT AS earnings_today,

    COALESCE((
      SELECT SUM(rps.commission_amount)
      FROM ride_pricing_snapshots rps
      JOIN rides r ON r.id = rps.ride_id
      WHERE r.status = 'completed'
      AND rps.snapshot_type = 'final'
      AND r.completed_at >= v_week_start
    ), 0)::BIGINT AS earnings_this_week,

    COALESCE((
      SELECT SUM(rps.commission_amount)
      FROM ride_pricing_snapshots rps
      JOIN rides r ON r.id = rps.ride_id
      WHERE r.status = 'completed'
      AND rps.snapshot_type = 'final'
      AND r.completed_at >= v_month_start
    ), 0)::BIGINT AS earnings_this_month,

    COALESCE((
      SELECT (pc.value #>> '{}')::NUMERIC FROM platform_config pc WHERE pc.key = 'commission_rate'
    ), 0.15) AS commission_rate;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_rides_by_day(p_days_back integer DEFAULT 30)
 RETURNS TABLE(day date, total bigint, completed bigint, canceled bigint, revenue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Havana')::date;
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing() OR public.is_operator()) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT d.day::DATE,
    COUNT(r.id) AS total,
    COUNT(r.id) FILTER (WHERE r.status = 'completed') AS completed,
    COUNT(r.id) FILTER (WHERE r.status = 'canceled') AS canceled,
    COALESCE(SUM(r.final_fare_cup) FILTER (WHERE r.status = 'completed'), 0)::numeric AS revenue
  FROM generate_series(v_today - (p_days_back - 1), v_today, '1 day'::INTERVAL) AS d(day)
  LEFT JOIN rides r ON (r.created_at AT TIME ZONE 'America/Havana')::DATE = d.day::DATE
  GROUP BY d.day
  ORDER BY d.day;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_rides_by_payment_method(p_days_back integer DEFAULT 30)
 RETURNS TABLE(payment_method text, count bigint, revenue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_start timestamptz := (((now() AT TIME ZONE 'America/Havana')::date - p_days_back)::timestamp AT TIME ZONE 'America/Havana');
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing() OR public.is_operator()) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT
    r.payment_method::TEXT,
    COUNT(r.id) AS count,
    COALESCE(SUM(r.final_fare_cup), 0)::numeric AS revenue
  FROM rides r
  WHERE r.status = 'completed'
    AND r.completed_at >= v_window_start
  GROUP BY r.payment_method
  ORDER BY revenue DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_rides_by_service_type(p_days_back integer DEFAULT 30)
 RETURNS TABLE(service_type text, count bigint, revenue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_start timestamptz := (((now() AT TIME ZONE 'America/Havana')::date - p_days_back)::timestamp AT TIME ZONE 'America/Havana');
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing() OR public.is_operator()) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT
    r.service_type::TEXT,
    COUNT(r.id) AS count,
    COALESCE(SUM(r.final_fare_cup), 0)::numeric AS revenue
  FROM rides r
  WHERE r.status = 'completed'
    AND r.completed_at >= v_window_start
  GROUP BY r.service_type
  ORDER BY revenue DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_corporate_month_spend()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_month_start timestamptz :=
    date_trunc('month', now() AT TIME ZONE 'America/Havana') AT TIME ZONE 'America/Havana';
  v_changed integer;
BEGIN
  UPDATE corporate_accounts ca
     SET current_month_spent = s.spent
    FROM (SELECT a.id,
                 COALESCE((SELECT SUM(cr.fare_trc) FROM corporate_rides cr
                           WHERE cr.corporate_account_id = a.id
                             AND cr.created_at >= v_month_start), 0)::integer AS spent
          FROM corporate_accounts a) s
   WHERE ca.id = s.id
     AND ca.current_month_spent IS DISTINCT FROM s.spent;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed;
END;
$function$;

CREATE OR REPLACE FUNCTION public.team_daily_metrics(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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

  -- The real rides requested that day: the rule of _team_digest_totals (a real customer, any driver).
  WITH r AS (
    SELECT r.id, r.status, r.driver_id, r.service_type, r.pickup_location,
           extract(hour FROM (r.created_at AT TIME ZONE 'America/Havana'))::integer AS hh
    FROM public.rides r
    JOIN public.users cu ON cu.id = r.customer_id
    WHERE r.created_at >= v_start AND r.created_at < v_end
      AND NOT cu.is_test AND cu.id <> c_platform
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
                            'completed', v.completed, 'no_driver', v.no_driver) ORDER BY v.requested DESC, v.name, v.slug)
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
          AND NOT EXISTS (SELECT 1 FROM public.users lu WHERE lu.id = pu.user_id AND lu.is_test)
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
$function$;

CREATE OR REPLACE FUNCTION public.tg_recurring_rides_client_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_count int;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT count(*) INTO v_count FROM public.recurring_rides
     WHERE customer_id = NEW.customer_id AND status <> 'deleted';
    IF v_count >= 10 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Puedes tener hasta 10 viajes recurrentes.',
        DETAIL = 'recurring_limit';
    END IF;
    NEW.created_at := now();
    NEW.last_triggered_at := NULL;
  ELSE
    NEW.created_at := OLD.created_at;
    NEW.last_triggered_at := OLD.last_triggered_at;
  END IF;

  IF NEW.days_of_week IS NULL OR cardinality(NEW.days_of_week) NOT BETWEEN 1 AND 7
     OR EXISTS (SELECT 1 FROM unnest(NEW.days_of_week) d WHERE d IS NULL OR d NOT BETWEEN 1 AND 7) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Elige al menos un día de la semana.',
      DETAIL = 'recurring_days';
  END IF;

  -- When the next ride is due is the server's call, from the days and the time.
  NEW.next_occurrence_at := CASE WHEN NEW.status = 'active'
    THEN public.compute_next_occurrence(NEW.days_of_week::smallint[], NEW.time_of_day, 'America/Havana')
    END;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_rides_validate_corporate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_status text;
  v_creator uuid;
  v_per_ride_cap integer;
  v_monthly_budget integer;
  v_month_spent integer;
  v_in_flight integer;
  v_fare integer;
  v_wallet_id uuid;
  v_balance integer;
  v_held integer;
  v_check_money boolean;
BEGIN
  IF NEW.corporate_account_id IS NULL THEN
    IF NEW.payment_method = 'corporate' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Elige la empresa que paga el viaje.',
        DETAIL = 'corporate_account_required';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status, created_by, per_ride_cap_trc, monthly_budget_trc
    INTO v_status, v_creator, v_per_ride_cap, v_monthly_budget
  FROM corporate_accounts WHERE id = NEW.corporate_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'La empresa que paga el viaje no existe.',
      DETAIL = 'corporate_not_found';
  END IF;
  IF v_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'La cuenta de la empresa no está habilitada para pagar viajes.',
      DETAIL = 'corporate_not_approved';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM corporate_employees
    WHERE corporate_account_id = NEW.corporate_account_id
      AND user_id = NEW.customer_id
      AND is_active = true
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'No eres empleado activo de esta empresa.',
      DETAIL = 'corporate_not_employee';
  END IF;

  v_fare := COALESCE(NULLIF(NEW.estimated_fare_trc, 0), NULLIF(NEW.estimated_fare_cup, 0), 0);
  IF TG_OP = 'INSERT' AND v_fare <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'No se pudo calcular el precio del viaje. Vuelve a intentarlo.',
      DETAIL = 'corporate_fare_required';
  END IF;

  IF COALESCE(v_per_ride_cap, 0) > 0 AND v_fare > v_per_ride_cap THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format('El viaje cuesta %s CUP y la empresa paga hasta %s CUP por viaje.', v_fare, v_per_ride_cap),
      DETAIL = 'corporate_over_ride_cap';
  END IF;

  -- Money: only while the company starts paying this ride or its estimate goes
  -- up, and only for a ride in flight.
  v_check_money := NEW.payment_method = 'corporate'
    AND NEW.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                       'in_progress', 'arrived_at_destination')
    AND (TG_OP = 'INSERT'
         OR NEW.corporate_account_id IS DISTINCT FROM OLD.corporate_account_id
         OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
         OR v_fare > COALESCE(NULLIF(OLD.estimated_fare_trc, 0), NULLIF(OLD.estimated_fare_cup, 0), 0));
  IF v_check_money IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Lock the wallet that funds the company (its creator's) before reading what
  -- is already committed against it, so concurrent rides queue here.
  SELECT id, balance, held_balance INTO v_wallet_id, v_balance, v_held
  FROM wallet_accounts
  WHERE user_id = v_creator AND account_type = 'corporate_cash'
  FOR UPDATE;

  IF COALESCE(v_monthly_budget, 0) > 0 THEN
    SELECT COALESCE(SUM(fare_trc), 0) INTO v_month_spent
    FROM corporate_rides
    WHERE corporate_account_id = NEW.corporate_account_id
      AND created_at >= (date_trunc('month', now() AT TIME ZONE 'America/Havana') AT TIME ZONE 'America/Havana');
    SELECT COALESCE(SUM(COALESCE(NULLIF(r.estimated_fare_trc, 0), NULLIF(r.estimated_fare_cup, 0), 0)), 0)
      INTO v_in_flight
    FROM rides r
    WHERE r.corporate_account_id = NEW.corporate_account_id
      AND r.payment_method = 'corporate'
      AND r.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                       'in_progress', 'arrived_at_destination')
      AND r.id <> NEW.id;
    IF v_month_spent + v_in_flight + v_fare > v_monthly_budget THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = format('El viaje cuesta %s CUP y al presupuesto mensual de la empresa le quedan %s CUP.',
                         v_fare, GREATEST(v_monthly_budget - v_month_spent - v_in_flight, 0)),
        DETAIL = 'corporate_over_monthly_budget';
    END IF;
  END IF;

  -- Prepaid: every company of the creator spends from the same wallet.
  SELECT COALESCE(SUM(COALESCE(NULLIF(r.estimated_fare_trc, 0), NULLIF(r.estimated_fare_cup, 0), 0)), 0)
    INTO v_in_flight
  FROM rides r
  JOIN corporate_accounts ca ON ca.id = r.corporate_account_id
  WHERE ca.created_by = v_creator
    AND r.payment_method = 'corporate'
    AND r.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                     'in_progress', 'arrived_at_destination')
    AND r.id <> NEW.id;
  IF v_wallet_id IS NULL OR v_fare > v_balance - v_held - v_in_flight THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'La empresa no tiene saldo suficiente para este viaje. Pídele a un administrador de la empresa que la recargue.',
      DETAIL = 'corporate_insufficient_balance';
  END IF;

  RETURN NEW;
END;
$function$;

RESET SESSION AUTHORIZATION;
