-- ============================================================
-- 00480_pricing_nonnegative_checks.sql
--
-- Admin audit 2026-07-02, batch 4: pricing_rules and
-- service_type_configs had ZERO CHECK constraints (verified against
-- pg_constraint in prod). The admin edit forms don't validate negatives
-- either (the create form does), so a typo'd negative base fare would
-- reach prod and poison fare calculation downstream.
--
-- Pre-flight (2026-07-02): 0 rows violate >= 0 across both tables
-- (16 pricing_rules, 6 service_type_configs), so plain ADD CONSTRAINT
-- (validated) is safe.
--
-- NULLs pass a CHECK by SQL semantics, which is what we want for the
-- nullable USD anchor columns.
-- ============================================================

ALTER TABLE public.pricing_rules
  DROP CONSTRAINT IF EXISTS pricing_rules_fares_nonnegative_chk;
ALTER TABLE public.pricing_rules
  ADD CONSTRAINT pricing_rules_fares_nonnegative_chk CHECK (
    base_fare_cup >= 0
    AND per_km_rate_cup >= 0
    AND per_minute_rate_cup >= 0
    AND min_fare_cup >= 0
    AND (base_fare_usd IS NULL OR base_fare_usd >= 0)
    AND (per_km_rate_usd IS NULL OR per_km_rate_usd >= 0)
    AND (per_minute_rate_usd IS NULL OR per_minute_rate_usd >= 0)
    AND (min_fare_usd IS NULL OR min_fare_usd >= 0)
  );

ALTER TABLE public.service_type_configs
  DROP CONSTRAINT IF EXISTS service_type_configs_fares_nonnegative_chk;
ALTER TABLE public.service_type_configs
  ADD CONSTRAINT service_type_configs_fares_nonnegative_chk CHECK (
    base_fare_cup >= 0
    AND per_km_rate_cup >= 0
    AND per_minute_rate_cup >= 0
    AND min_fare_cup >= 0
    AND (per_wait_minute_rate_cup IS NULL OR per_wait_minute_rate_cup >= 0)
    AND (base_fare_usd IS NULL OR base_fare_usd >= 0)
    AND (per_km_rate_usd IS NULL OR per_km_rate_usd >= 0)
    AND (per_minute_rate_usd IS NULL OR per_minute_rate_usd >= 0)
    AND (min_fare_usd IS NULL OR min_fare_usd >= 0)
    AND (per_wait_minute_rate_usd IS NULL OR per_wait_minute_rate_usd >= 0)
  );

COMMENT ON CONSTRAINT pricing_rules_fares_nonnegative_chk ON public.pricing_rules IS
  '00480: fares can never go negative; last line of defense behind the admin UI validation.';
COMMENT ON CONSTRAINT service_type_configs_fares_nonnegative_chk ON public.service_type_configs IS
  '00480: fares can never go negative; last line of defense behind the admin UI validation.';
