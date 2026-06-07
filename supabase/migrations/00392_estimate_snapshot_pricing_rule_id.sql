-- 00392: estimate snapshot records the active pricing_rule (F3-A traceability)
--
-- The estimate snapshot is created by tg_rides_create_estimate_snapshot (00299),
-- which hardcoded `pricing_rule_id = NULL`. So every ride_pricing_snapshots row
-- had a NULL pricing_rule_id and we couldn't tell which time-banded pricing_rule
-- priced a ride. (The client matched a rule in getLocalFareEstimate, but that id
-- never reached the snapshot — the trigger has no rides column to read it from,
-- and the service-layer manual insert is pre-empted by this trigger.)
--
-- This is TRACEABILITY ONLY — it does NOT change any money field. The snapshot's
-- `total`/`subtotal`/rates/commission are untouched; strict parity in
-- complete_ride_and_pay (which reads `total`) is unaffected.
--
-- Fix: the trigger now looks up the active pricing_rule for NEW.service_type at
-- creation time (Havana local time, same basis as the client's matchPricingRule:
-- non-overlapping windows that tile 24h, day_of_week NULL = all days) and stores
-- its id. The lookup is wrapped in its own sub-block with EXCEPTION → NULL so it
-- can NEVER break snapshot creation (degrades to the prior NULL behavior).
--
-- Verified read-only before writing: the match returns exactly 1 active rule per
-- service at any time. Body below is an exact reproduction of the live function
-- with only the guarded lookup + the `NULL` → `v_rule_id` change.

CREATE OR REPLACE FUNCTION public.tg_rides_create_estimate_snapshot()
 RETURNS trigger
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
BEGIN
  IF NEW.estimated_fare_cup IS NULL OR NEW.estimated_fare_cup <= 0 THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ride_pricing_snapshots
    WHERE ride_id = NEW.id AND snapshot_type = 'estimate'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_svc
  FROM public.service_type_configs
  WHERE slug = NEW.service_type AND is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- F3-A traceability: which active pricing_rule was in effect (Havana local
  -- time, same basis as the client estimate). Fully guarded: any failure leaves
  -- v_rule_id NULL (prior behavior) and never blocks the snapshot insert.
  BEGIN
    v_now_t   := (now() AT TIME ZONE 'America/Havana')::time;
    v_now_dow := EXTRACT(dow FROM now() AT TIME ZONE 'America/Havana')::int;
    SELECT pr.id INTO v_rule_id
    FROM public.pricing_rules pr
    WHERE pr.service_type = NEW.service_type
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

  v_eff_per_km := COALESCE(NEW.driver_custom_rate_cup, v_svc.per_km_rate_cup);

  SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
  FROM public.platform_config WHERE key = 'commission_rate';
  v_commission_rate := COALESCE(v_commission_rate, 0.15);

  IF NEW.corporate_account_id IS NOT NULL THEN
    SELECT commission_percent / 100.0 INTO v_corp_commission_rate
    FROM public.corporate_accounts WHERE id = NEW.corporate_account_id;
  END IF;

  IF v_corp_commission_rate IS NOT NULL AND v_corp_commission_rate < v_commission_rate THEN
    v_commission_amount := ROUND(NEW.estimated_fare_cup * v_corp_commission_rate)::int;
  ELSE
    v_commission_amount := ROUND(NEW.estimated_fare_cup * v_commission_rate)::int;
  END IF;

  INSERT INTO public.ride_pricing_snapshots (
    ride_id, snapshot_type, base_fare, per_km_rate, per_minute_rate,
    distance_m, duration_s, surge_multiplier, subtotal,
    commission_rate, commission_amount, total, pricing_rule_id,
    exchange_rate_usd_cup, total_trc,
    min_fare, corporate_commission_rate, default_commission_rate_snapshot
  ) VALUES (
    NEW.id, 'estimate',
    v_svc.base_fare_cup, v_eff_per_km, v_svc.per_minute_rate_cup,
    NEW.estimated_distance_m, NEW.estimated_duration_s, NEW.surge_multiplier,
    NEW.estimated_fare_cup,
    COALESCE(v_corp_commission_rate, v_commission_rate),
    v_commission_amount,
    NEW.estimated_fare_cup,
    v_rule_id,
    NEW.exchange_rate_usd_cup, NEW.estimated_fare_trc,
    v_svc.min_fare_cup, v_corp_commission_rate, v_commission_rate
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_rides_create_estimate_snapshot failed for ride %: % %',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;