-- 00440_price_update_time_bands_2026.sql
--
-- Price update based on the "Análisis de Tarifas Taxi Cuba" reference report
-- (a competing Uber-style app operating in Yaguajay, Sancti Spíritus).
--
-- Decisions (confirmed with the business owner 2026-06-17):
--   • Adopt the report's STRUCTURE (per-vehicle min fare, vehicle ladder,
--     three time bands), but at moderated amounts — NOT the full 2-3x jump.
--     Chosen "Día (Medio)" level: roughly the midpoint between current real
--     prices and the report. The Auto (auto_standard) tier is raised more to
--     fix the vehicle ladder (it was cheap relative to the triciclo).
--   • Keep three time bands Día / Noche / Madrugada with FLAT multipliers:
--     Noche = 1.5x the Día rates, Madrugada = 2.0x the Día rates.
--   • Surge stays weather-only (migs 00375/00376). No time-band surge is
--     reintroduced; the band increases live directly in the rate tables.
--
-- Mechanism note: time bands are already live nationally through
-- public.pricing_rules. getLocalFareEstimate() fetches active rules by
-- service_type (NOT filtered by city/zone) and matchPricingRule() selects the
-- row whose [time_window_start, time_window_end) contains the current time.
-- The four existing windows give full 24h coverage:
--     00:00-06:00 = Madrugada, 06:00-12:00 = Mañana (Día),
--     12:00-18:00 = Tarde (Día), 18:00-00:00 = Noche.
-- complete_ride_and_pay uses strict-parity (snapshot.total = the fare the
-- rider saw), so this DATA change needs NO engine / RPC / trigger changes.
--
-- This migration is DATA-only and idempotent (plain UPDATEs keyed by
-- service_type + time window). It does not touch row ids, so existing
-- ride_pricing_snapshots.pricing_rule_id references remain valid.

-- ─────────────────────────────────────────────────────────────────────────
-- 1) service_type_configs — align the Día (default / fallback) rates.
--    These are the values used when no pricing rule matches and the audit
--    columns of the estimate snapshot. Keep them equal to the Día band so
--    the fallback matches daytime pricing.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.service_type_configs SET
  base_fare_cup = 450, per_km_rate_cup = 380, per_minute_rate_cup = 38, min_fare_cup = 2000,
  updated_at = now()
WHERE slug = 'moto_standard';

UPDATE public.service_type_configs SET
  base_fare_cup = 700, per_km_rate_cup = 650, per_minute_rate_cup = 55, min_fare_cup = 3000,
  updated_at = now()
WHERE slug = 'triciclo_basico';

UPDATE public.service_type_configs SET
  base_fare_cup = 1100, per_km_rate_cup = 1150, per_minute_rate_cup = 85, min_fare_cup = 5000,
  updated_at = now()
WHERE slug = 'auto_standard';

UPDATE public.service_type_configs SET
  base_fare_cup = 1700, per_km_rate_cup = 1550, per_minute_rate_cup = 120, min_fare_cup = 7000,
  updated_at = now()
WHERE slug = 'auto_confort';

-- Keep the (inactive) triciclo_premium aligned with triciclo_basico Día so it
-- is sane if ever re-activated.
UPDATE public.service_type_configs SET
  base_fare_cup = 700, per_km_rate_cup = 650, per_minute_rate_cup = 55, min_fare_cup = 3000,
  updated_at = now()
WHERE slug = 'triciclo_premium';

-- ─────────────────────────────────────────────────────────────────────────
-- 2) pricing_rules — the live per-band tables (4 windows × 4 vehicles).
--    Día  = 06:00-12:00 and 12:00-18:00  (base rates)
--    Noche= 18:00-00:00                  (x1.5, rounded)
--    Madr.= 00:00-06:00                  (x2.0)
-- ─────────────────────────────────────────────────────────────────────────

-- ── Moto (Día 450 / 380 / 38 / 2000) ──────────────────────────────────────
UPDATE public.pricing_rules SET
  base_fare_cup = 450, per_km_rate_cup = 380, per_minute_rate_cup = 38, min_fare_cup = 2000, updated_at = now()
WHERE service_type = 'moto_standard' AND time_window_start = '06:00:00' AND time_window_end = '12:00:00';
UPDATE public.pricing_rules SET
  base_fare_cup = 450, per_km_rate_cup = 380, per_minute_rate_cup = 38, min_fare_cup = 2000, updated_at = now()
WHERE service_type = 'moto_standard' AND time_window_start = '12:00:00' AND time_window_end = '18:00:00';
UPDATE public.pricing_rules SET
  base_fare_cup = 675, per_km_rate_cup = 570, per_minute_rate_cup = 57, min_fare_cup = 3000, updated_at = now()
WHERE service_type = 'moto_standard' AND time_window_start = '18:00:00' AND time_window_end = '00:00:00';
UPDATE public.pricing_rules SET
  base_fare_cup = 900, per_km_rate_cup = 760, per_minute_rate_cup = 76, min_fare_cup = 4000, updated_at = now()
WHERE service_type = 'moto_standard' AND time_window_start = '00:00:00' AND time_window_end = '06:00:00';

-- ── Triciclo (Día 700 / 650 / 55 / 3000) ──────────────────────────────────
UPDATE public.pricing_rules SET
  base_fare_cup = 700, per_km_rate_cup = 650, per_minute_rate_cup = 55, min_fare_cup = 3000, updated_at = now()
WHERE service_type = 'triciclo_basico' AND time_window_start = '06:00:00' AND time_window_end = '12:00:00';
UPDATE public.pricing_rules SET
  base_fare_cup = 700, per_km_rate_cup = 650, per_minute_rate_cup = 55, min_fare_cup = 3000, updated_at = now()
WHERE service_type = 'triciclo_basico' AND time_window_start = '12:00:00' AND time_window_end = '18:00:00';
UPDATE public.pricing_rules SET
  base_fare_cup = 1050, per_km_rate_cup = 975, per_minute_rate_cup = 83, min_fare_cup = 4500, updated_at = now()
WHERE service_type = 'triciclo_basico' AND time_window_start = '18:00:00' AND time_window_end = '00:00:00';
UPDATE public.pricing_rules SET
  base_fare_cup = 1400, per_km_rate_cup = 1300, per_minute_rate_cup = 110, min_fare_cup = 6000, updated_at = now()
WHERE service_type = 'triciclo_basico' AND time_window_start = '00:00:00' AND time_window_end = '06:00:00';

-- ── Auto standard (Día 1100 / 1150 / 85 / 5000) ───────────────────────────
UPDATE public.pricing_rules SET
  base_fare_cup = 1100, per_km_rate_cup = 1150, per_minute_rate_cup = 85, min_fare_cup = 5000, updated_at = now()
WHERE service_type = 'auto_standard' AND time_window_start = '06:00:00' AND time_window_end = '12:00:00';
UPDATE public.pricing_rules SET
  base_fare_cup = 1100, per_km_rate_cup = 1150, per_minute_rate_cup = 85, min_fare_cup = 5000, updated_at = now()
WHERE service_type = 'auto_standard' AND time_window_start = '12:00:00' AND time_window_end = '18:00:00';
UPDATE public.pricing_rules SET
  base_fare_cup = 1650, per_km_rate_cup = 1725, per_minute_rate_cup = 128, min_fare_cup = 7500, updated_at = now()
WHERE service_type = 'auto_standard' AND time_window_start = '18:00:00' AND time_window_end = '00:00:00';
UPDATE public.pricing_rules SET
  base_fare_cup = 2200, per_km_rate_cup = 2300, per_minute_rate_cup = 170, min_fare_cup = 10000, updated_at = now()
WHERE service_type = 'auto_standard' AND time_window_start = '00:00:00' AND time_window_end = '06:00:00';

-- ── Auto confort (Día 1700 / 1550 / 120 / 7000) ───────────────────────────
UPDATE public.pricing_rules SET
  base_fare_cup = 1700, per_km_rate_cup = 1550, per_minute_rate_cup = 120, min_fare_cup = 7000, updated_at = now()
WHERE service_type = 'auto_confort' AND time_window_start = '06:00:00' AND time_window_end = '12:00:00';
UPDATE public.pricing_rules SET
  base_fare_cup = 1700, per_km_rate_cup = 1550, per_minute_rate_cup = 120, min_fare_cup = 7000, updated_at = now()
WHERE service_type = 'auto_confort' AND time_window_start = '12:00:00' AND time_window_end = '18:00:00';
UPDATE public.pricing_rules SET
  base_fare_cup = 2550, per_km_rate_cup = 2325, per_minute_rate_cup = 180, min_fare_cup = 10500, updated_at = now()
WHERE service_type = 'auto_confort' AND time_window_start = '18:00:00' AND time_window_end = '00:00:00';
UPDATE public.pricing_rules SET
  base_fare_cup = 3400, per_km_rate_cup = 3100, per_minute_rate_cup = 240, min_fare_cup = 14000, updated_at = now()
WHERE service_type = 'auto_confort' AND time_window_start = '00:00:00' AND time_window_end = '06:00:00';
