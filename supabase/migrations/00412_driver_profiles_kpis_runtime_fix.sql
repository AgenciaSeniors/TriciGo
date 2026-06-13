-- 00412_driver_profiles_kpis_runtime_fix.sql
-- ============================================================================
-- Fix: the driver KPIs maintained by the system never update in runtime —
-- same class of bug as the tier (00411), but on driver_profiles and affecting
-- MORE fields, including ones that drive matching.
--
-- Root cause (verified in prod via rolled-back E2E):
--   `tg_driver_profiles_protect_admin_fields` (BEFORE UPDATE) reverts ~21
--   columns (NEW.x := OLD.x) for any authenticated non-admin caller. But the
--   system RPCs/triggers that maintain the DERIVED counters/scores run exactly
--   in that context:
--     * rating_avg            <- apply_user_rating (reviewer / driver)
--     * total_rides_completed <- complete_ride_and_pay (driver)
--     * total_rides_offered   <- tg_ride_offer_increment_offered (ride insert = customer)
--     * acceptance_rate       <- tg_ride_offer_refresh_acceptance (accept = driver)
--     * match_score           <- update_driver_score (completion/rating triggers = driver ctx)
--   So all of those writes got silently reverted. Impact: driver star rating
--   frozen (it weighs 20% in find_best_drivers AND is shown to riders AND the
--   cancellation-reputation penalty can't lower it), ride/offer/acceptance
--   counters frozen. Proof: completing a ride as the driver left
--   total_rides_completed at 120 (real count 7); a rating_avg UPDATE as the
--   reviewer left it unchanged.
--
-- Fix (same pattern as 00411): the system writers mark their UPDATE with the
-- transaction-local GUC `app.trusted_driver_update` (which the client cannot
-- set — PostgREST cannot run set_config). The protect trigger honors that flag
-- for the DERIVED fields only, still fully protecting the admin-only fields
-- (status, approved_at, suspended_*, identity_number, criminal record,
-- custom_per_km_rate_cup, user_id/id/created_at) and still enforcing the
-- is_online->approved guard.
--
-- The flag is intentionally NOT cleared by the writers: it is transaction-local
-- (auto-reset at commit/rollback), and a transaction is either a system RPC (in
-- which case every driver_profiles write IS legitimate) or a direct client
-- UPDATE via PostgREST (which never sets the flag). Clearing mid-function would
-- also break nesting (e.g. update_driver_score runs inside complete_ride_and_pay
-- via the completion-score trigger and would otherwise wipe complete's flag).
--
-- Out of scope (legacy, deprecated wallets — not in the live flow): the quota
-- (grace_trips_remaining/quota_blocked via deduct_driver_quota/
-- recharge_driver_quota on the deprecated driver_quota wallet) and
-- is_financially_eligible/negative_balance_since via check_driver_eligibility
-- (on the dead driver_cash wallet). The trigger already lets those fields
-- through WHEN the flag is set; if those paths are ever revived, add the same
-- set_config line to them.
-- ============================================================================

-- 1) Protect trigger: honor the trusted flag for derived fields only.
--    (Body verbatim from live prod; only the trusted-flag branch is new.)
CREATE OR REPLACE FUNCTION public.tg_driver_profiles_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- DRV-002a: is_online -> true requires status='approved'. (always enforced)
  IF NEW.is_online IS DISTINCT FROM OLD.is_online
     AND NEW.is_online = true
     AND COALESCE(OLD.status::text, 'pending_verification') <> 'approved' THEN
    RAISE EXCEPTION 'driver_not_approved_for_online: status=% — cannot go online until approved by admin',
      OLD.status;
  END IF;

  -- Trusted system update: revert ONLY the admin-only fields; let the derived
  -- counters/scores (rating, ride/offer counts, acceptance, match score, quota
  -- and eligibility) through. The client cannot set this GUC.
  IF current_setting('app.trusted_driver_update', true) = '1' THEN
    NEW.status                  := OLD.status;
    NEW.approved_at             := OLD.approved_at;
    NEW.suspended_at            := OLD.suspended_at;
    NEW.suspended_reason        := OLD.suspended_reason;
    NEW.identity_number         := OLD.identity_number;
    NEW.has_criminal_record     := OLD.has_criminal_record;
    NEW.criminal_record_details := OLD.criminal_record_details;
    NEW.custom_per_km_rate_cup  := OLD.custom_per_km_rate_cup;
    NEW.user_id                 := OLD.user_id;
    NEW.id                      := OLD.id;
    NEW.created_at              := OLD.created_at;
    RETURN NEW;
  END IF;

  NEW.status                  := OLD.status;
  NEW.is_financially_eligible := OLD.is_financially_eligible;
  NEW.negative_balance_since  := OLD.negative_balance_since;
  NEW.match_score             := OLD.match_score;
  NEW.acceptance_rate         := OLD.acceptance_rate;
  NEW.total_rides             := OLD.total_rides;
  NEW.total_rides_completed   := OLD.total_rides_completed;
  NEW.total_rides_offered     := OLD.total_rides_offered;
  NEW.rating_avg              := OLD.rating_avg;
  NEW.approved_at             := OLD.approved_at;
  NEW.suspended_at            := OLD.suspended_at;
  NEW.suspended_reason        := OLD.suspended_reason;
  NEW.grace_trips_remaining   := OLD.grace_trips_remaining;
  NEW.quota_blocked           := OLD.quota_blocked;
  NEW.identity_number         := OLD.identity_number;
  NEW.has_criminal_record     := OLD.has_criminal_record;
  NEW.criminal_record_details := OLD.criminal_record_details;
  NEW.user_id                 := OLD.user_id;
  NEW.id                      := OLD.id;
  NEW.created_at              := OLD.created_at;
  NEW.custom_per_km_rate_cup  := OLD.custom_per_km_rate_cup;

  RETURN NEW;
END;
$function$;

-- 2) apply_user_rating — rating_avg (driver) / customer_profiles (rider).
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
$function$;

-- 3) tg_ride_offer_increment_offered — total_rides_offered.
CREATE OR REPLACE FUNCTION public.tg_ride_offer_increment_offered()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  PERFORM set_config('app.trusted_driver_update', '1', true);
  UPDATE driver_profiles
     SET total_rides_offered = COALESCE(total_rides_offered, 0) + 1
   WHERE id = NEW.driver_profile_id;
  RETURN NEW;
END;
$function$;

-- 4) tg_ride_offer_refresh_acceptance — acceptance_rate.
CREATE OR REPLACE FUNCTION public.tg_ride_offer_refresh_acceptance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_total    integer;
  v_accepted integer;
BEGIN
  -- Only act on terminal-state transitions
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_total
  FROM ride_offers
  WHERE driver_profile_id = NEW.driver_profile_id;

  SELECT COUNT(*) INTO v_accepted
  FROM ride_offers
  WHERE driver_profile_id = NEW.driver_profile_id
    AND status = 'accepted';

  PERFORM set_config('app.trusted_driver_update', '1', true);
  UPDATE driver_profiles
     SET acceptance_rate = CASE
       WHEN v_total = 0 THEN 100.0
       ELSE LEAST(100.0, ROUND(100.0 * v_accepted::numeric / v_total, 1))
     END
   WHERE id = NEW.driver_profile_id;

  RETURN NEW;
END;
$function$;

-- 5) update_driver_score — match_score.
CREATE OR REPLACE FUNCTION public.update_driver_score(p_driver_id uuid, p_event_type text, p_details jsonb DEFAULT NULL::jsonb)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_delta DECIMAL;
  v_new_score DECIMAL;
BEGIN
  -- BUG-136: gate direct callers. Triggers (pg_trigger_depth > 0)
  -- and admin tools (is_admin()) bypass.
  IF pg_trigger_depth() = 0 AND NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: update_driver_score can only be called by admins or by internal triggers';
  END IF;

  CASE p_event_type
    WHEN 'ride_completed' THEN v_delta := 2.0;
    WHEN '5_star_rating' THEN v_delta := 5.0;
    WHEN '4_star_rating' THEN v_delta := 2.0;
    WHEN '3_star_rating' THEN v_delta := 0.0;
    WHEN '2_star_rating' THEN v_delta := -5.0;
    WHEN '1_star_rating' THEN v_delta := -10.0;
    WHEN 'cancel_by_driver' THEN v_delta := -5.0;
    WHEN 'sos_report' THEN v_delta := -20.0;
    WHEN 'tip_received' THEN v_delta := 3.0;
    WHEN 'ride_declined' THEN v_delta := -1.0;
    WHEN 'consecutive_completions_5' THEN v_delta := 5.0;
    WHEN 'admin_adjustment' THEN
      v_delta := COALESCE((p_details->>'delta')::DECIMAL, 0);
    ELSE
      v_delta := 0;
  END CASE;

  IF v_delta = 0 AND p_event_type != 'admin_adjustment' THEN
    RETURN (SELECT match_score FROM driver_profiles WHERE user_id = p_driver_id);
  END IF;

  INSERT INTO driver_score_events (driver_id, event_type, delta, details)
  VALUES (p_driver_id, p_event_type, v_delta, p_details);

  PERFORM set_config('app.trusted_driver_update', '1', true);
  UPDATE driver_profiles
  SET match_score = GREATEST(0, LEAST(100, match_score + v_delta))
  WHERE user_id = p_driver_id
  RETURNING match_score INTO v_new_score;

  RETURN COALESCE(v_new_score, 50.0);
END;
$function$;

-- 6) complete_ride_and_pay (~24k chars) — total_rides_completed. Patch in-place
--    (set the flag right after the function's opening BEGIN) so we cannot drop
--    any feature from the large body. Idempotent + safe on absence.
DO $patch$
DECLARE
  v_src text;
  v_anchor text := E'BEGIN\n  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;';
  v_repl  text := E'BEGIN\n  PERFORM set_config(''app.trusted_driver_update'', ''1'', true);\n  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;';
BEGIN
  SELECT pg_get_functiondef('public.complete_ride_and_pay(uuid,uuid,integer,integer)'::regprocedure) INTO v_src;
  IF v_src IS NULL THEN
    RAISE NOTICE 'complete_ride_and_pay absent; skipping patch';
  ELSIF position('app.trusted_driver_update' IN v_src) > 0 THEN
    RAISE NOTICE 'complete_ride_and_pay already patched; skipping';
  ELSIF position(v_anchor IN v_src) = 0 THEN
    RAISE WARNING 'complete_ride_and_pay anchor not found; total_rides_completed will stay frozen — re-check anchor';
  ELSE
    EXECUTE replace(v_src, v_anchor, v_repl);
    RAISE NOTICE 'complete_ride_and_pay patched with trusted_driver_update flag';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'complete_ride_and_pay signature mismatch; skipping patch';
END $patch$;
