-- 00501 — Match competitor fares on the NIGHT band (18:00-00:00)
--
-- APPLIED TO PROD 2026-07-17 via execute_sql (owner authorized: "Aplicar ahora,
-- todo"). This file is the versioned record; re-running it is a no-op.
--
-- Source: owner captured the competitor's published rate card at 9pm Cuba time.
-- Only the night band was quoted, so ONLY the night band is changed here — the
-- other three bands (00-06, 06-12, 12-18) keep their current values until a
-- real quote for those hours exists. Do not extrapolate: the competitor is
-- dynamic by hour (see the pricing memory / 00489-00491).
--
-- Every value the owner quoted divides cleanly by 660 — the live exchange rate —
-- so the competitor anchors in USD just like we do (moto base 151.8 = $0.23,
-- wait 79.20 = $0.12). CUP columns are INTEGER, so quoted decimals are rounded
-- (151.8 -> 152, 19.8 -> 20, 2336.4 -> 2336, 79.20 -> 79); sub-peso drift.
--
-- ⚠️ The `*_usd` columns are the source of truth: the hourly `sync-exchange-rate`
-- cron recomputes CUP = round(USD × rate). Setting CUP alone would be reverted
-- on the next run, so both are set here (usd = cup/660). Verified after apply:
-- round(usd × 660) = cup for all 4 services.
--
-- NOTE — this RAISES fares (the competitor moved up; we were below them):
-- triciclo +41% @2km / +29% @11.3km, moto +28% @2km, auto -8% @11.3km.
--
-- ROLLBACK (previous night-band values, in case this needs reverting):
--   moto_standard   base 0    per_km 301  per_min 0  min 825
--   triciclo_basico base 763  per_km 375  per_min 0  min 1655
--   auto_standard   base 217  per_km 867  per_min 0  min 2276
--   auto_confort    base 1414 per_km 1199 per_min 0  min 5390
--   per_wait_minute_rate_cup: moto 24, triciclo 29, auto 49, confort 78
--   (reverting must also reset the matching *_usd = cup/660, or the cron
--    undoes the revert on its next run.)

-- ── Night band (18:00-00:00) ──
UPDATE public.pricing_rules pr SET
  base_fare_cup       = v.base,     base_fare_usd       = v.base / 660.0,
  per_km_rate_cup     = v.per_km,   per_km_rate_usd     = v.per_km / 660.0,
  per_minute_rate_cup = v.per_min,  per_minute_rate_usd = v.per_min / 660.0,
  min_fare_cup        = v.min_fare, min_fare_usd        = v.min_fare / 660.0,
  updated_at = now()
FROM (VALUES
  ('moto_standard',   152,  290,  20, 1056),
  ('triciclo_basico', 244,  501,  33, 2336),
  ('auto_standard',   297,  726,  40, 2277),
  ('auto_confort',    1148, 1195, 86, 5095)
) AS v(slug, base, per_km, per_min, min_fare)
WHERE pr.service_type = v.slug
  AND pr.time_window_start = '18:00:00'
  AND pr.is_active = true;

-- ── Wait charge: 79 CUP/min ($0.12) ──
-- Lives on the vehicle config, which has NO time bands → this one applies 24h,
-- not just at night. Free minutes (5) and the 20-minute billable cap are
-- unchanged. 'mensajeria' is deliberately skipped: a delivery is charged as the
-- vehicle the rider picks (#419), so its config is dead.
UPDATE public.service_type_configs SET
  per_wait_minute_rate_cup = 79,
  per_wait_minute_rate_usd = 79 / 660.0,
  updated_at = now()
WHERE slug IN ('moto_standard','triciclo_basico','auto_standard','auto_confort');

-- min_fare_cup in service_type_configs is the floor the BEFORE INSERT trigger
-- (tg_rides_validate_estimated_fare) checks. It is NOT touched: it still holds
-- the cheapest band's minimum (moto 750 / triciclo 1505 / auto 2069 / confort
-- 4900), which stays <= every band's minimum, so no ride is ever rejected.
