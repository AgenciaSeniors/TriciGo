-- Live bodies dumped from prod on 2026-10-08 with pg_get_functiondef (read-only MCP query).
-- The 00642 rehearsal loads them as they run in prod; run.sh (L1) checks each md5.

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
$function$
;

CREATE OR REPLACE FUNCTION public.admin_signup_code_stats()
 RETURNS TABLE(code text, label text, channel text, audience text, is_active boolean, created_at timestamp with time zone, signups bigint, rider_signups bigint, driver_signups bigint, drivers_approved bigint, riders_with_ride bigint, drivers_with_ride bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH u AS (
    SELECT u.id, u.signup_code, dp.id AS dp_id, dp.status AS dp_status
    FROM public.users u
    LEFT JOIN public.driver_profiles dp ON dp.user_id = u.id
    WHERE u.signup_code IS NOT NULL
  )
  SELECT
    ac.code, ac.label, ac.channel, ac.audience, ac.is_active, ac.created_at,
    count(u.id),
    count(u.id) FILTER (WHERE u.dp_id IS NULL),
    count(u.id) FILTER (WHERE u.dp_id IS NOT NULL),
    count(u.id) FILTER (WHERE u.dp_status = 'approved'),
    count(u.id) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.rides r WHERE r.customer_id = u.id AND r.status = 'completed')),
    count(u.id) FILTER (WHERE u.dp_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.rides r WHERE r.driver_id = u.dp_id AND r.status = 'completed'))
  FROM public.acquisition_codes ac
  LEFT JOIN u ON u.signup_code = ac.code
  GROUP BY ac.code, ac.label, ac.channel, ac.audience, ac.is_active, ac.created_at
  ORDER BY count(u.id) DESC, ac.created_at DESC;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_user_rating(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_role text;
  v_avg  numeric;
BEGIN
  PERFORM set_config('app.trusted_driver_update', '1', true);
  SELECT role::text INTO v_role FROM users WHERE id = p_user_id;
  v_avg := recompute_user_rating(p_user_id);
  IF v_role = 'driver' THEN
    UPDATE driver_profiles SET rating_avg = v_avg WHERE user_id = p_user_id;
  ELSIF v_role IN ('customer', 'super_admin', 'admin') THEN
    UPDATE customer_profiles SET rating_avg = v_avg WHERE user_id = p_user_id;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_ride_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user_role user_role;
  v_transition_valid BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
    VALUES (NEW.id, OLD.status, NEW.status, NULL, 'admin');
    RETURN NEW;
  END IF;

  SELECT role INTO v_user_role FROM users WHERE id = auth.uid();

  IF v_user_role NOT IN ('admin', 'super_admin')
     AND NEW.driver_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM driver_profiles dp
       WHERE dp.id = NEW.driver_id
         AND dp.user_id = auth.uid()
         AND dp.status = 'approved'
     ) THEN
    v_user_role := 'driver';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM valid_transitions
    WHERE from_status = OLD.status
      AND to_status = NEW.status
      AND v_user_role = ANY(allowed_roles)
  ) INTO v_transition_valid;

  IF NOT v_transition_valid THEN
    RAISE EXCEPTION 'Invalid ride transition from % to % for role %',
      OLD.status, NEW.status, v_user_role;
  END IF;

  INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid(), v_user_role);

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ensure_driver_role_and_tricicoin_on_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.status = 'approved'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
    -- Promote ONLY plain customers; leave admin/super_admin alone.
    -- Their elevated role takes precedence over the driver flag —
    -- the effective_role logic in 00143 already treats them as
    -- driver for ride transitions when they own the driver_profile.
    UPDATE users
       SET role = 'driver'
     WHERE id = NEW.user_id
       AND role NOT IN ('driver', 'admin', 'super_admin');

    -- Wallet provisioning is safe for any role (admins testing
    -- as drivers still need a tricicoin wallet to accept rides).
    INSERT INTO wallet_accounts (user_id, account_type, balance)
    VALUES (NEW.user_id, 'tricicoin'::wallet_account_type, 0)
    ON CONFLICT (user_id, account_type) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_active_push_user_ids(p_active_days integer DEFAULT 30)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_user_ids uuid[];
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;

  IF p_active_days > 90 OR p_active_days < 1 THEN
    RAISE EXCEPTION 'p_active_days must be between 1 and 90';
  END IF;

  SELECT array_agg(DISTINCT ud.user_id)
  INTO v_user_ids
  FROM user_devices ud
  JOIN auth.users au ON au.id = ud.user_id
  WHERE ud.push_token IS NOT NULL
    AND ud.push_token <> ''
    AND au.last_sign_in_at >= now() - (p_active_days || ' days')::interval;

  RETURN COALESCE(v_user_ids, ARRAY[]::uuid[]);
END;
$function$
;

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
  IF NOT public.is_admin() THEN
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_admin_wallet_stats()
 RETURNS TABLE(total_in_circulation bigint, pending_redemptions_count bigint, pending_redemptions_amount bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    (SELECT COALESCE(SUM(balance), 0) FROM wallet_accounts
     WHERE is_active = true)
      AS total_in_circulation,
    (SELECT COUNT(*) FROM wallet_redemptions
     WHERE status = 'requested')
      AS pending_redemptions_count,
    (SELECT COALESCE(SUM(amount), 0) FROM wallet_redemptions
     WHERE status = 'requested')
      AS pending_redemptions_amount;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_rides_by_day(p_days_back integer DEFAULT 30)
 RETURNS TABLE(day date, total bigint, completed bigint, canceled bigint, revenue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Havana')::date;
BEGIN
  IF NOT is_admin() THEN
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_rides_by_payment_method(p_days_back integer DEFAULT 30)
 RETURNS TABLE(payment_method text, count bigint, revenue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_start timestamptz := (((now() AT TIME ZONE 'America/Havana')::date - p_days_back)::timestamp AT TIME ZONE 'America/Havana');
BEGIN
  IF NOT is_admin() THEN
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_rides_by_service_type(p_days_back integer DEFAULT 30)
 RETURNS TABLE(service_type text, count bigint, revenue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_start timestamptz := (((now() AT TIME ZONE 'America/Havana')::date - p_days_back)::timestamp AT TIME ZONE 'America/Havana');
BEGIN
  IF NOT is_admin() THEN
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_top_drivers(p_limit integer DEFAULT 10)
 RETURNS TABLE(driver_id uuid, driver_name text, rides_count bigint, rating numeric, revenue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    dp.id AS driver_id,
    u.full_name AS driver_name,
    COALESCE(COUNT(*) FILTER (WHERE r.status = 'completed'), 0) AS rides_count,
    dp.rating_avg AS rating,
    COALESCE(SUM(r.final_fare_cup) FILTER (WHERE r.status = 'completed'), 0)::numeric AS revenue
  FROM driver_profiles dp
  JOIN users u ON u.id = dp.user_id
  LEFT JOIN rides r ON r.driver_id = dp.id
  WHERE dp.status = 'approved'
  GROUP BY dp.id, u.full_name, dp.rating_avg
  ORDER BY revenue DESC, rides_count DESC
  LIMIT p_limit;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron, triggers without a user. None of
  -- them is an admin, and anon may not even call current_user_role().
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE id = auth.uid()
      AND role = 'super_admin'
  );
$function$
;

CREATE OR REPLACE FUNCTION public.promote_user_role(p_target_user_id uuid, p_new_role user_role, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller_uid uuid;
  v_old_role   user_role;
BEGIN
  v_caller_uid := auth.uid();

  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;

  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden: only super_admin can promote user roles';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'reason required (min 10 chars)';
  END IF;

  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'p_target_user_id required';
  END IF;

  IF p_new_role IS NULL THEN
    RAISE EXCEPTION 'p_new_role required';
  END IF;

  SELECT role INTO v_old_role FROM users WHERE id = p_target_user_id;
  IF v_old_role IS NULL THEN
    RAISE EXCEPTION 'target user not found: %', p_target_user_id;
  END IF;

  IF v_old_role = p_new_role THEN
    RETURN jsonb_build_object(
      'success', true,
      'no_change', true,
      'target_user_id', p_target_user_id,
      'role', p_new_role
    );
  END IF;

  UPDATE users SET role = p_new_role WHERE id = p_target_user_id;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (
    v_caller_uid,
    'promote_user_role',
    'user',
    p_target_user_id::TEXT,
    p_reason || ' [from=' || v_old_role || ' to=' || p_new_role || ']'
  );

  RETURN jsonb_build_object(
    'success', true,
    'target_user_id', p_target_user_id,
    'old_role', v_old_role,
    'new_role', p_new_role,
    'reason', p_reason
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_acquisition_codes_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  NEW.code := upper(btrim(NEW.code));
  IF EXISTS (SELECT 1 FROM public.referral_codes WHERE code = NEW.code) THEN
    RAISE EXCEPTION 'El código % ya es un código de referido de un usuario', NEW.code
      USING ERRCODE = '23505';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$function$
;
