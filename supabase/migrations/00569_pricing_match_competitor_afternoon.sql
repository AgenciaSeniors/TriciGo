-- 00569 — Match competitor fares on the AFTERNOON (12:00-18:00) band
--
-- Source: owner captured the competitor's fare-estimate screen for the 4 vehicle
-- types at 5:51-5:52 PM (17:51-17:52), two trips: 2.03 km / 6 min and
-- 4.39 km / 12 min. That falls inside the 12:00-18:00 band.
--
-- The competitor's own "Costo por distancia" / "Tiempo de viaje" breakdown lines
-- were IDENTICAL between the two trips despite the different distance/duration
-- (a caching bug on their side) — not usable to derive per-unit rates. Only the
-- "Precio estimado" TOTAL changed sensibly with distance, so — same method as
-- 00470 — fit price(km) = base + per_km × km from the two observed totals per
-- vehicle, per_minute = 0 (no reliable time signal to extract).
--
--   moto_standard    665.00 @ 2.03km  /  1044.05 @ 4.39km
--   triciclo_basico 1396.50 @ 2.03km  /  1655.85 @ 4.39km
--   auto_standard   1655.85 @ 2.03km  /  2952.60 @ 4.39km
--   auto_confort    2753.10 @ 2.03km  /  4262.64 @ 4.39km
--
-- Owner decision (explicit): match the competitor EXACTLY, no 10% discount
-- margin (unlike 00470's standing "always 10% below" policy — overridden here
-- per owner instruction for this capture).
--
-- EFFECT: the 12:00-18:00 band becomes the CHEAPEST of the 4 daily bands for
-- all 4 vehicles (previously 06:00-12:00 was cheapest). Roughly -20% to -45%
-- vs the current 12-18 values, per vehicle:
--   moto      base 0->339    per_km 304->161  min 831->665
--   triciclo  base 769->1173 per_km 378->110  min 1668->1397
--   basico    base 218->540  per_km 873->549  min 2293->1656
--   confort   base 1424->1455 per_km 1208->640 min 5431->2753
--
-- Because this band now undercuts the previous cheapest band (06-12), the
-- absolute safety floor in service_type_configs.min_fare_cup (checked by the
-- BEFORE INSERT trigger tg_rides_validate_estimated_fare on every ride) must
-- come down too, or dawn/afternoon rides at the new lower price would be
-- rejected as "below minimum". See 00501's note: that floor must always stay
-- <= every band's minimum.
--
-- *_usd columns are the source of truth (hourly sync-exchange-rate cron
-- recomputes CUP = round(USD × rate)); both are set here. Rate at time of
-- writing: 665 CUP/USD (usd = cup / 665).
--
-- ROLLBACK (previous 12:00-18:00 values):
--   moto_standard   base 0    per_km 304 per_min 0 min 831
--   triciclo_basico base 769  per_km 378 per_min 0 min 1668
--   auto_standard   base 218  per_km 873 per_min 0 min 2293
--   auto_confort    base 1424 per_km 1208 per_min 0 min 5431
--   service_type_configs.min_fare_cup: moto 678, triciclo 1516, auto_standard
--     1936, auto_confort 3824
--   (reverting must also reset the matching *_usd = cup/rate, or the
--    sync-exchange-rate cron undoes the revert on its next run.)

-- ── Afternoon band (12:00-18:00) ──
UPDATE public.pricing_rules pr SET
  base_fare_cup       = v.base,     base_fare_usd       = round((v.base / 665.0)::numeric, 4),
  per_km_rate_cup     = v.per_km,   per_km_rate_usd     = round((v.per_km / 665.0)::numeric, 4),
  per_minute_rate_cup = 0,          per_minute_rate_usd = 0,
  min_fare_cup        = v.min_fare, min_fare_usd        = round((v.min_fare / 665.0)::numeric, 4),
  updated_at = now()
FROM (VALUES
  ('moto_standard',   339,  161, 665),
  ('triciclo_basico', 1173, 110, 1397),
  ('auto_standard',   540,  549, 1656),
  ('auto_confort',    1455, 640, 2753)
) AS v(slug, base, per_km, min_fare)
WHERE pr.service_type = v.slug
  AND pr.time_window_start = '12:00:00'
  AND pr.is_active = true;

-- ── service_type_configs: lower the absolute safety floor to match the new
--    cheapest band (this migration's afternoon band). base_fare_cup /
--    per_km_rate_cup (the no-rule-matches fallback) are left untouched. ──
UPDATE public.service_type_configs SET
  min_fare_cup = v.min_fare, min_fare_usd = round((v.min_fare / 665.0)::numeric, 4),
  updated_at = now()
FROM (VALUES
  ('moto_standard',   665),
  ('triciclo_basico', 1397),
  ('auto_standard',   1656),
  ('auto_confort',    2753)
) AS v(slug, min_fare)
WHERE service_type_configs.slug = v.slug;
