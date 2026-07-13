-- 00494_commission_rate_zero_guard.sql
--
-- Bug: a driver completed a cash ride but no platform commission (15%) was
-- deducted. Root cause was `platform_config.commission_rate` being set to `0`
-- (changed 2026-07-06, most likely from the super-admin platform-config panel).
--
-- The commission rate is resolved with `COALESCE(<config>, 0.15)` in two DB
-- objects, and COALESCE only rescues NULL — it treats a stored `0` as a valid
-- 0% rate. So:
--   1. tg_rides_create_estimate_snapshot snapshots commission_rate = 0.
--   2. complete_ride_and_pay reads that 0 from the snapshot -> commission 0.
--   3. For cash rides the driver's only ledger movement is the commission
--      debit, so a 0 commission emits NO ledger entry at all.
--
-- The TypeScript estimate path (packages/api/src/services/ride.service.ts) already
-- guards `parsed > 0 && parsed < 1` and falls back to 0.15. This migration brings
-- the DB objects in line so a mis-set config can never again silently apply 0%.
--
-- The live config value itself is corrected out-of-band; the self-heal UPDATE
-- below makes fresh / non-prod databases consistent without clobbering a
-- deliberately-set custom rate inside the valid (0,1) range.

-- 1) Self-heal any invalid stored commission_rate (0 / NULL / >=1) back to 15%.
--    A legitimate custom rate strictly inside (0,1) is left untouched.
UPDATE public.platform_config
SET value = '0.15'::jsonb, updated_at = now()
WHERE key = 'commission_rate'
  AND (
    value IS NULL
    OR (value #>> '{}') IS NULL
    OR (value #>> '{}')::numeric <= 0
    OR (value #>> '{}')::numeric >= 1
  );

-- 2) Harden the estimate-snapshot trigger: treat 0 / NULL / out-of-range as
--    invalid and fall back to the 15% default. Body reproduced from the live
--    definition (lineage: 00299), with only the commission-rate guard added.
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

  -- F3-A traceability: which active pricing_rule was in effect (Havana local time).
  -- Fully guarded: any failure leaves v_rule_id NULL and never blocks the insert.
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
  -- Guard: 0 / NULL / out-of-range (>=1) is invalid -> fall back to 15%.
  -- COALESCE alone only rescued NULL, so a config value of 0 silently produced
  -- 0% commission on every ride (matches ride.service.ts `parsed > 0 && < 1`).
  IF v_commission_rate IS NULL OR v_commission_rate <= 0 OR v_commission_rate >= 1 THEN
    v_commission_rate := 0.15;
  END IF;

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

-- 3) Harden complete_ride_and_pay's platform-default rate resolution the same
--    way, via in-place patch of the LIVE body (per CLAUDE.md: don't re-transcribe
--    a 24k-char RPC verbatim -- it risks silently dropping features). The guard is
--    inserted only around the PLATFORM default; the corporate override path
--    (which may legitimately be a lower/zero rate) is left untouched.
DO $patch$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef('public.complete_ride_and_pay(uuid,uuid,integer,integer)'::regprocedure)
    INTO v_src;

  -- Idempotency: only patch if the guard marker is not already present, and the
  -- exact anchor exists.
  IF v_src IS NOT NULL
     AND position('commission_rate_zero_guard' IN v_src) = 0
     AND position('v_commission_rate := v_default_commission_rate;' IN v_src) > 0 THEN
    v_src := replace(
      v_src,
      'v_commission_rate := v_default_commission_rate;',
      '-- commission_rate_zero_guard (00494): 0/NULL/>=1 platform default is invalid -> 15%'
      || E'\n  IF v_default_commission_rate IS NULL OR v_default_commission_rate <= 0 OR v_default_commission_rate >= 1 THEN'
      || E'\n    v_default_commission_rate := 0.15;'
      || E'\n  END IF;'
      || E'\n  v_commission_rate := v_default_commission_rate;'
    );
    EXECUTE v_src;
    RAISE NOTICE '00494: complete_ride_and_pay patched with commission_rate_zero_guard';
  ELSE
    RAISE NOTICE '00494: complete_ride_and_pay patch skipped (already applied or anchor missing)';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00494: complete_ride_and_pay absent; skipping patch';
END $patch$;
