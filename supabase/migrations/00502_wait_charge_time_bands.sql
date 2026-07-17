-- 00502 — Wait charge becomes time-banded (like the fares already are)
--
-- WHY. The competitor prices waiting by hour: the owner quoted 79.20 CUP/min at
-- 9pm and 264.00 CUP/min at 00:15 — 3.3x. Our wait rate lived ONLY on
-- service_type_configs, which has no time bands, so it was a single 24h value
-- and the two quotes could not both be honoured. Owner picked the real fix
-- (explicitly authorized via AskUserQuestion: "Darle franjas horarias").
--
-- WHAT.
--   1. pricing_rules gets per_wait_minute_rate_cup/_usd (nullable).
--   2. calculate_wait_charge() picks the rate from the band matching the hour,
--      falling back to service_type_configs when the band has no rate.
--   3. recompute_cup_from_usd_prices() also recomputes the new column, so the
--      banded wait rate stays anchored to USD like every other fare.
--
-- NULL = "this band has no wait rate of its own" -> falls back to the vehicle
-- config. Morning (06-12) and afternoon (12-18) are left NULL on purpose: the
-- competitor has not been quoted at those hours yet. Do not invent values.
--
-- The rate is chosen by driver_arrived_at (when the wait actually began), NOT
-- now(). complete_ride_and_pay calls this via PERFORM at completion time, which
-- can land in a different band than the wait itself — and re-running it must
-- always produce the same charge.

-- ── 1. Columns ──
ALTER TABLE public.pricing_rules
  ADD COLUMN IF NOT EXISTS per_wait_minute_rate_cup INTEGER,
  ADD COLUMN IF NOT EXISTS per_wait_minute_rate_usd NUMERIC;

COMMENT ON COLUMN public.pricing_rules.per_wait_minute_rate_cup IS
  '00502: wait charge per billable minute for this time band. NULL -> fall back '
  'to service_type_configs.per_wait_minute_rate_cup. Derived: the *_usd column '
  'is the source of truth (recompute_cup_from_usd_prices rewrites this hourly).';

-- ── 2. Seed the two quoted bands (USD is the source of truth; rate 660) ──
-- Night 18:00-00:00 -> $0.12 (79 CUP)   | quoted 9pm
-- Dawn  00:00-06:00 -> $0.40 (264 CUP)  | quoted 00:15
UPDATE public.pricing_rules SET
  per_wait_minute_rate_usd = 0.12,
  per_wait_minute_rate_cup = ROUND(0.12 * 660),
  updated_at = now()
WHERE time_window_start = '18:00:00' AND is_active = true
  AND service_type IN ('moto_standard','triciclo_basico','auto_standard','auto_confort');

UPDATE public.pricing_rules SET
  per_wait_minute_rate_usd = 0.40,
  per_wait_minute_rate_cup = ROUND(0.40 * 660),
  updated_at = now()
WHERE time_window_start = '00:00:00' AND is_active = true
  AND service_type IN ('moto_standard','triciclo_basico','auto_standard','auto_confort');

-- ── 3. calculate_wait_charge: band-aware ──
-- Reproduced from the LIVE body (last redefined in 00432); the ONLY change is
-- how v_charge's rate is resolved. Free minutes and the billable cap are
-- untouched.
CREATE OR REPLACE FUNCTION public.calculate_wait_charge(p_ride_id uuid)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride rides%ROWTYPE;
  v_svc service_type_configs%ROWTYPE;
  v_wait_seconds NUMERIC;
  v_wait_minutes INTEGER;
  v_billable_minutes INTEGER;
  v_max_billable INTEGER;
  v_charge INTEGER;
  v_band_rate INTEGER;
  v_at_t time;
  v_at_dow int;
  result RECORD;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  SELECT * INTO v_svc FROM service_type_configs WHERE slug = v_ride.service_type;

  IF v_ride.driver_arrived_at IS NOT NULL AND v_ride.pickup_at IS NOT NULL THEN
    v_wait_seconds := EXTRACT(EPOCH FROM (v_ride.pickup_at::timestamptz - v_ride.driver_arrived_at::timestamptz));
    v_wait_minutes := GREATEST(0, FLOOR(v_wait_seconds / 60)::INTEGER);
    v_billable_minutes := GREATEST(0, v_wait_minutes - COALESCE(v_svc.free_wait_minutes, 5));
    v_max_billable := GREATEST(0, get_platform_config_numeric('max_billable_wait_minutes', 20)::INTEGER);
    v_billable_minutes := LEAST(v_billable_minutes, v_max_billable);

    -- 00502: rate from the band the wait STARTED in (Havana time). Same window
    -- matching as tg_rides_create_estimate_snapshot, incl. overnight windows.
    BEGIN
      v_at_t   := (v_ride.driver_arrived_at AT TIME ZONE 'America/Havana')::time;
      v_at_dow := EXTRACT(dow FROM (v_ride.driver_arrived_at AT TIME ZONE 'America/Havana'))::int;
      SELECT pr.per_wait_minute_rate_cup INTO v_band_rate
      FROM public.pricing_rules pr
      WHERE pr.service_type = v_ride.service_type
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
      v_band_rate := NULL;  -- never let band lookup break the charge
    END;

    v_charge := v_billable_minutes * COALESCE(v_band_rate, v_svc.per_wait_minute_rate_cup, 0);
  ELSE
    v_wait_minutes := 0; v_billable_minutes := 0; v_charge := 0;
  END IF;

  UPDATE rides SET wait_time_minutes = v_wait_minutes, wait_time_charge_cup = v_charge WHERE id = p_ride_id;

  SELECT v_wait_minutes AS wait_minutes, v_billable_minutes AS billable_minutes, v_charge AS charge INTO result;
  RETURN result;
END;
$function$;

-- ── 4. Keep the USD anchor honest for the new column ──
-- Reproduced from the LIVE body; the ONLY change is the added per_wait line in
-- the pricing_rules UPDATE. Without it the banded wait rate would freeze in CUP
-- while every other fare tracked the dollar.
CREATE OR REPLACE FUNCTION public.recompute_cup_from_usd_prices()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_rate numeric;
BEGIN
  SELECT usd_cup_rate INTO v_rate FROM public.exchange_rates WHERE is_current = true LIMIT 1;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    SELECT (value #>> '{}')::numeric INTO v_rate FROM public.platform_config WHERE key = 'exchange_rate_fallback_cup';
  END IF;
  v_rate := COALESCE(v_rate, 520);

  UPDATE public.service_type_configs SET
    base_fare_cup            = ROUND(base_fare_usd            * v_rate),
    per_km_rate_cup          = ROUND(per_km_rate_usd          * v_rate),
    per_minute_rate_cup      = ROUND(per_minute_rate_usd      * v_rate),
    min_fare_cup             = ROUND(min_fare_usd             * v_rate),
    per_wait_minute_rate_cup = ROUND(per_wait_minute_rate_usd * v_rate),
    updated_at = now()
  WHERE base_fare_usd IS NOT NULL;

  UPDATE public.pricing_rules SET
    base_fare_cup       = ROUND(base_fare_usd       * v_rate),
    per_km_rate_cup     = ROUND(per_km_rate_usd     * v_rate),
    per_minute_rate_cup = ROUND(per_minute_rate_usd * v_rate),
    min_fare_cup        = ROUND(min_fare_usd        * v_rate),
    -- 00502: NULL stays NULL (band has no rate of its own -> vehicle fallback).
    per_wait_minute_rate_cup = ROUND(per_wait_minute_rate_usd * v_rate),
    updated_at = now()
  WHERE base_fare_usd IS NOT NULL;
END;
$function$;
