-- 00662 — Interim fare table: one day price, night +30 %, dawn +60 %
--
-- Approved by the owner 2026-10-15 ("aplicalo"), as a stopgap while the
-- market study (driver survey + fixed-route captures) is under way. It is
-- not the final, cost-based price; that comes after the study.
--
-- WHY
--   Today's four bands were copied from two competitors at different times
--   (00441, 00470, 00501, 00569, 00593) and no longer make sense together:
--     * Night and dawn are 1.3-3x the day price. A 2 km triciclo trip costs
--       1,380 CUP at 17:59 and 4,326 at 00:00. Against Cinco's own night
--       quotes (study of 2026-09-22/24) we were +20-50 % at night and up to
--       +70 % at dawn.
--     * The afternoon band (12-18) has a high flag-fall and a tiny per-km,
--       so a 5 km triciclo trip costs ~2,800 at 11:59 and ~1,790 at 12:00.
--     * By day, the per-km rates put triciclo and auto above Cinco on a
--       typical trip (5.7 km Altahabana -> Cerro, 2026-10-03: Cinco moto
--       1,527 / triciclo 2,146 / auto 3,788 CUP).
--
-- WHAT CHANGES (all four active services except mensajería)
--   One shape per service: fare = max(base + per_km x km, min). per_minute
--   goes to 0 in every band, so the price no longer depends on traffic or
--   on OSRM's time estimate.
--   Day (06-12 and 12-18, identical), CUP at the 775 CUP/USD design rate:
--                 base   per_km   min
--     moto         178     223    unchanged (day minimum, = the fare floor)
--     triciclo     963     191    unchanged
--     auto         459     551    unchanged
--     Confort      597     716    unchanged   (auto x1.3, as in 00593)
--   The day minimums are not touched: 00593 already matched Cinco there.
--   Night 18-24 = day x1.3 on every component (min included).
--   Dawn  00-06 = day x1.6 on every component (min included).
--   Fit: day prices land 3-5 % below Cinco's 5.7 km quote for moto,
--   triciclo and auto (Confort ~3 % above); night/dawn minimums land below
--   Cinco's night quotes for the short Centro Habana route.
--
--   Waiting-time rates (per_wait_minute_rate_*) are NOT touched.
--
-- WHAT DOES NOT NEED TO CHANGE
--   * Fare floor (tg_rides_validate_estimated_fare reads
--     service_type_configs.min_fare_cup): the day minimums stay equal to
--     it and every other band's minimum is higher, so no trip falls under
--     it. Asserted below.
--   * The apps: they read pricing_rules at quote time, so the new table is
--     live as soon as this runs; no app release. In-flight rides keep their
--     estimate snapshot (strict parity).
--   * Stops surcharge (00633) reads service_type_configs, not these bands.
--
-- MECHANICS
--   Only *_usd columns are written (CUP / 775); recompute_cup_from_usd_prices()
--   derives every CUP column from the CURRENT rate, like the FX cron. At
--   another rate every CUP value moves in the same proportion (at 795 CUP/USD
--   they are ~2.6 % above the table above).
--
-- IDEMPOTENT: re-running writes the same values.
--
-- ROLLBACK (exact *_usd values before this migration; run
-- recompute_cup_from_usd_prices() afterwards). base / per_km / per_min / min:
--   moto_standard   00:00 0.25000000000000000000 / 0.51060606060606060606 / 0.05000000000000000000 / 2.5196969696969697
--   moto_standard   06:00 0.00000000000000000000 / 0.35000000000000000000 / 0.01969696969696969697 / 0.80555555555555555556
--   moto_standard   12:00 0.44444444444444444444 / 0.2421 / 0 / 0.80555555555555555556
--   moto_standard   18:00 0.23030303030303030303 / 0.43939393939393939394 / 0.03030303030303030303 / 1.6000000000000000
--   triciclo_basico 00:00 0.85000000000000000000 / 0.96060606060606060606 / 0.08030303030303030303 / 5.4409090909090909
--   triciclo_basico 06:00 0.25909090909090909091 / 0.58939393939393939394 / 0.03030303030303030303 / 1.7361111111111111
--   triciclo_basico 12:00 1.4861111111111111 / 0.1654 / 0 / 1.7361111111111111
--   triciclo_basico 18:00 0.36969696969696969697 / 0.75909090909090909091 / 0.05000000000000000000 / 3.5393939393939394
--   auto_standard   00:00 0.66969696969696969697 / 1.2303030303030303 / 0.10000000000000000000 / 4.2696969696969697
--   auto_standard   06:00 0.23939393939393939394 / 1.0696969696969697 / 0.03939393939393939394 / 2.0138888888888889
--   auto_standard   12:00 0.77777777777777777778 / 0.8256 / 0 / 2.0138888888888889
--   auto_standard   18:00 0.45000000000000000000 / 1.1000000000000000 / 0.06060606060606060606 / 3.4500000000000000
--   auto_confort    00:00 0.87500000000000000000 / 1.5972222222222222 / 0.12500000000000000000 / 4.7083333333333333
--   auto_confort    06:00 0.30555555555555555556 / 1.3888888888888889 / 0.05555555555555555556 / 2.6111111111111111
--   auto_confort    12:00 1.0138888888888889 / 1.0694444444444444 / 0.00000000000000000000 / 2.6111111111111111
--   auto_confort    18:00 0.58333333333333333333 / 1.4305555555555556 / 0.08333333333333333333 / 3.6666666666666667

UPDATE public.pricing_rules pr SET
  base_fare_usd       = d.base_cup   / 775.0 * b.factor,
  per_km_rate_usd     = d.per_km_cup / 775.0 * b.factor,
  per_minute_rate_usd = 0,
  min_fare_usd        = d.min_usd * b.factor,
  updated_at          = now()
FROM (VALUES
  -- slug, day base (CUP@775), day per_km (CUP@775), day min (USD, unchanged)
  ('moto_standard',   178, 223, 0.80555555555555555556::numeric),
  ('triciclo_basico', 963, 191, 1.7361111111111111::numeric),
  ('auto_standard',   459, 551, 2.0138888888888889::numeric),
  ('auto_confort',    597, 716, 2.6111111111111111::numeric)
) AS d(slug, base_cup, per_km_cup, min_usd)
CROSS JOIN (VALUES
  ('06:00:00'::time, 1.0::numeric),
  ('12:00:00'::time, 1.0::numeric),
  ('18:00:00'::time, 1.3::numeric),
  ('00:00:00'::time, 1.6::numeric)
) AS b(win, factor)
WHERE pr.service_type = d.slug
  AND pr.time_window_start = b.win
  AND pr.is_active = true;

-- ── Derive every CUP column from the current rate (same path as the FX cron) ──
SELECT public.recompute_cup_from_usd_prices();

-- ── Assertions: abort the whole migration if anything did not land ──
DO $check$
DECLARE
  v_rows int;
  v_bad  text;
BEGIN
  -- All 16 targeted bands carry the new shape.
  SELECT count(*) INTO v_rows
  FROM public.pricing_rules pr
  JOIN (VALUES
    ('moto_standard',   178, 223),
    ('triciclo_basico', 963, 191),
    ('auto_standard',   459, 551),
    ('auto_confort',    597, 716)
  ) AS d(slug, base_cup, per_km_cup) ON pr.service_type = d.slug
  JOIN (VALUES
    ('06:00:00'::time, 1.0), ('12:00:00'::time, 1.0),
    ('18:00:00'::time, 1.3), ('00:00:00'::time, 1.6)
  ) AS b(win, factor) ON pr.time_window_start = b.win
  WHERE pr.is_active
    AND round(pr.base_fare_usd   * 775) = round(d.base_cup   * b.factor)
    AND round(pr.per_km_rate_usd * 775) = round(d.per_km_cup * b.factor)
    AND pr.per_minute_rate_usd = 0;
  IF v_rows <> 16 THEN
    RAISE EXCEPTION '00662: expected 16 updated bands, found %', v_rows;
  END IF;

  -- Night and dawn always cost more than the day band of the same service.
  SELECT string_agg(n.service_type || ' ' || n.time_window_start, ', ') INTO v_bad
  FROM public.pricing_rules n
  JOIN public.pricing_rules dy
    ON dy.service_type = n.service_type AND dy.time_window_start = '06:00:00' AND dy.is_active
  WHERE n.is_active
    AND n.service_type IN ('moto_standard','triciclo_basico','auto_standard','auto_confort')
    AND n.time_window_start IN ('18:00:00','00:00:00')
    AND (n.min_fare_usd <= dy.min_fare_usd OR n.per_km_rate_usd <= dy.per_km_rate_usd);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00662: night/dawn not above day for %', v_bad;
  END IF;

  -- Floor invariant: no band's minimum may sit below the trigger's floor.
  SELECT string_agg(sc.slug, ', ') INTO v_bad
  FROM public.service_type_configs sc
  WHERE sc.slug IN ('moto_standard','triciclo_basico','auto_standard','auto_confort')
    AND sc.min_fare_cup > (SELECT min(pr.min_fare_cup) FROM public.pricing_rules pr
                           WHERE pr.service_type = sc.slug AND pr.is_active);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00662: fare floor above a band minimum for %', v_bad;
  END IF;
END
$check$;
