-- ============================================================================
-- 00376 — Drop zone-based + demand-based dynamic pricing (total elimination)
--
-- APPLY ONLY AFTER:
--   1. 00375 is applied (adds get_weather_surge + repoints complete_ride_and_pay)
--   2. The new sync-weather EF is deployed (writes weather_surge_multiplier)
--   3. The new apps are deployed (estimate calls get_weather_surge, not
--      calculate_dynamic_surge)
--
-- Weather surge is kept (now a single global multiplier in platform_config,
-- read via get_weather_surge). Everything dropped here is zone/demand only.
--
-- Pre-flight verified on prod: no FK, view, trigger, policy, or index depends on
-- surge_zones / surge_predictions / zones.surge_multiplier /
-- pricing_rules.surge_threshold / pricing_rules.max_surge_multiplier. The only
-- DB caller of get_surge_multiplier (complete_ride_and_pay) was repointed in 00375.
-- KEPT: rides.surge_multiplier and ride_pricing_snapshots.surge_multiplier (they
-- now hold the weather factor + back strict-parity / audit).
-- ============================================================================

-- ── Surge RPCs (zone + demand) ───────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.calculate_dynamic_surge(uuid, double precision, double precision, integer);
DROP FUNCTION IF EXISTS public.calculate_surge(uuid);
DROP FUNCTION IF EXISTS public.get_surge_multiplier(geography);

-- ── Surge predictions engine (zone/hour) + its daily cron ────────────────────
-- Idempotent unschedule: runs cron.unschedule once per matching job (0 or 1).
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'calculate-surge-predictions';
DROP FUNCTION IF EXISTS public.calculate_surge_predictions();
DROP TABLE IF EXISTS public.surge_predictions;

-- ── Surge zones table (was the per-zone store; weather moved to platform_config) ──
DROP TABLE IF EXISTS public.surge_zones;

-- ── Zone / pricing-rule surge columns ────────────────────────────────────────
ALTER TABLE public.zones DROP COLUMN IF EXISTS surge_multiplier;
ALTER TABLE public.pricing_rules DROP COLUMN IF EXISTS surge_threshold;
ALTER TABLE public.pricing_rules DROP COLUMN IF EXISTS max_surge_multiplier;
