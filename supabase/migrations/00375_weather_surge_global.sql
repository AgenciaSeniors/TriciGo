-- ============================================================================
-- 00375 — Weather-only surge (global), phase ADD
--
-- Part of removing zone-based + demand-based dynamic pricing. Weather surge is
-- KEPT but redesigned as a single GLOBAL multiplier (no longer per-zone via the
-- surge_zones table). The sync-weather Edge Function now writes
-- platform_config.weather_surge_multiplier; this migration adds get_weather_surge()
-- to read it, and repoints complete_ride_and_pay's legacy fallback at it.
--
-- This migration only ADDS (safe to apply before deploying the new apps/EF).
-- The DROP of zone/demand objects happens in 00376, AFTER the apps stop calling
-- calculate_dynamic_surge / get_surge_multiplier.
-- ============================================================================

-- ── Config keys (idempotent) ────────────────────────────────────────────────
-- value is JSONB; JSON numbers parse cleanly via get_platform_config_numeric.
-- weather_surge_enabled already exists. weather_surge_multiplier is maintained
-- by the sync-weather EF; the seed is just the "clear weather" default.
INSERT INTO platform_config (key, value) VALUES
  ('weather_surge_multiplier', '1.0'::jsonb),
  ('weather_cold_threshold_c', '12'::jsonb),
  ('weather_cold_multiplier',  '1.3'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── get_weather_surge() — the only surge source left ────────────────────────
-- Global (city-wide) factor. Returns 1.0 when weather surge is disabled or the
-- config is missing. Defensive clamp to [1.0, 3.0]. No zone / demand / geo input.
CREATE OR REPLACE FUNCTION public.get_weather_surge()
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_enabled TEXT;
  v_mult NUMERIC;
BEGIN
  SELECT (value #>> '{}') INTO v_enabled FROM platform_config WHERE key = 'weather_surge_enabled';
  IF v_enabled IS NOT NULL AND lower(v_enabled) = 'false' THEN
    RETURN 1.0;
  END IF;
  v_mult := get_platform_config_numeric('weather_surge_multiplier', 1.0);
  RETURN LEAST(GREATEST(COALESCE(v_mult, 1.0), 1.0), 3.0);
END;
$function$;

-- Mirror the execute surface the client-facing surge RPC had.
REVOKE EXECUTE ON FUNCTION public.get_weather_surge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_weather_surge() TO anon, authenticated, service_role;

-- ── complete_ride_and_pay: legacy fallback now uses weather, not zone lookup ──
-- complete_ride_and_pay is a ~24k-char money RPC. Rather than re-paste the whole
-- body (transcription risk), we repoint EXACTLY one expression in the live
-- definition: the third COALESCE arg of the v_surge assignment, only reached on
-- the legacy (pre-snapshot) path:
--   get_surge_multiplier(v_ride.pickup_location)  ->  get_weather_surge()
-- The strict-parity branch (snapshot) is untouched. The block fetches the
-- current definition, applies the single substitution, asserts it happened, and
-- re-creates the function — identical result on prod and on a fresh DB (both have
-- the same line at this point in the migration order).
DO $repoint$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'complete_ride_and_pay'
  LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION '00375: complete_ride_and_pay not found';
  END IF;

  IF position('get_surge_multiplier(v_ride.pickup_location)' IN v_def) > 0 THEN
    -- Normal first run: repoint the single legacy fallback expression.
    v_def := replace(v_def,
      'get_surge_multiplier(v_ride.pickup_location)',
      'get_weather_surge()');
    IF position('get_surge_multiplier' IN v_def) > 0 THEN
      RAISE EXCEPTION '00375: residual get_surge_multiplier reference after repoint';
    END IF;
    EXECUTE v_def;
  ELSIF position('get_weather_surge()' IN v_def) > 0 THEN
    -- Idempotent: already repointed (e.g. migration re-run after 00376). No-op.
    RAISE NOTICE '00375: complete_ride_and_pay already repointed to get_weather_surge(); skipping';
  ELSE
    RAISE EXCEPTION '00375: complete_ride_and_pay has neither the expected fallback nor get_weather_surge()';
  END IF;
END
$repoint$;
