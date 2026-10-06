-- 00593 — Phase 1 of the Cinco price response: day-band minimum fares + Confort
--
-- Approved by the owner 2026-09-24 ("Sí, aplica la fase 1").
--
-- SOURCE
--   14 screenshots of the Cinco app (2026-09-22 20:55 → 2026-09-24 09:33), one
--   short route inside Centro Habana (Allende / Zanja → Padre Varela), all four
--   comparable categories (Moto / Triciclo / Básico / Confort). Cinco prices are
--   dynamic (the same trip moved up to 2.4x within a day) and always shown as
--   90 % of a struck-through "original" price. Its unsurged price for that trip
--   repeats across the morning captures: moto 585, auto 1,480 CUP.
--
-- FINDING
--   Cinco charged less for the WHOLE trip than our MINIMUM fare in 14/14 auto,
--   14/14 Confort, 12/14 moto and 11/14 triciclo captures. At the short end the
--   comparison does not depend on distance: we never charge below our minimum.
--   Confort was the outlier — our minimum was 1.7–2.2x the auto minimum; Cinco
--   prices Confort at ~1.3x Básico.
--
-- WHAT CHANGES (CUP at 720 CUP/USD; *_usd is the source of truth)
--   Day bands 06-12 and 12-18, moto / triciclo / auto — minimum fare only:
--     moto      734 / 720   → 580   (Cinco unsurged 585)
--     triciclo 1886 / 1513  → 1250  (kept below auto, as today)
--     auto     2096 / 1793  → 1450  (Cinco unsurged 1,480)
--   12-18 has a high flag-fall (00569 matched La Nave's afternoon card), so its
--   base is lowered just enough for a ~1.5 km trip to land on the new minimum:
--     moto 367 → 320 · triciclo 1270 → 1070 · auto 585 → 560.
--   Per-km / per-minute are NOT touched: we only have competitor data for a
--   short trip, and our real rides are long (median 4.8 km; 23 of 221 ≤ 2 km).
--
--   Confort = auto x1.3 on every component, all four bands:
--     06-12  220 / 1000 / 40 / 1880      12-18  730 / 770 / 0 / 1880
--     18-24  420 / 1030 / 60 / 2640      00-06  630 / 1150 / 90 / 3390
--   (base / per_km / per_min / min). The 18-24 and 00-06 minimums were derived
--   from the phase-2 auto night minimums (2030 / 2610), so until phase 2 lands
--   Confort's night minimum sits only ~6-10 % above today's auto minimum.
--
--   Night (18-24) and dawn (00-06) for moto / triciclo / auto are deliberately
--   left alone: 00501 raised them to La Nave's card because drivers are scarce at
--   those hours. That is phase 2, to be decided after measuring phase 1.
--
-- EXPECTED IMPACT (221 real rides, re-priced at today's rate, same distance/hour)
--   Total revenue −4.1 % (completed rides −4.3 %); moto −1.8 %, triciclo −4.1 %,
--   auto −0.4 %, Confort −18 % (4 rides). Drivers keep 85 %, so they lose in the
--   same proportion; a short morning auto trip pays the driver 1,233 instead of
--   1,782 CUP.
--
-- FLOOR INVARIANT
--   tg_rides_validate_estimated_fare rejects any ride whose estimated_fare_cup is
--   below service_type_configs.min_fare_cup. That floor must stay <= the cheapest
--   band's minimum, or every short trip would fail at creation. It is lowered here
--   together with the bands, and asserted at the end.
--
-- MECHANICS
--   Only *_usd columns are written (cup / 720); recompute_cup_from_usd_prices()
--   then derives every CUP column from the CURRENT rate, exactly like the FX cron
--   does. In-flight rides are unaffected: strict parity charges each ride its own
--   estimate snapshot.
--
-- IDEMPOTENT: re-running writes the same values.
--
-- ROLLBACK (exact *_usd values before this migration; run recompute afterwards)
--   pricing_rules
--     moto_standard   06:00 min 1.0196969696969697
--     moto_standard   12:00 base 0.5098  min 1.0000
--     triciclo_basico 06:00 min 2.6196969696969697
--     triciclo_basico 12:00 base 1.7639  min 2.1008
--     auto_standard   06:00 min 2.9106060606060606
--     auto_standard   12:00 base 0.8120  min 2.4902
--     auto_confort    06:00 0.31060606060606060606 / 1.6303030303030303 / 0.08030303030303030303 / 5.7500000000000000
--     auto_confort    12:00 2.1880 / 0.9624 / 0 / 4.1398
--     auto_confort    18:00 1.7393939393939394 / 1.8106060606060606 / 0.13030303030303030303 / 7.7196969696969697
--     auto_confort    00:00 1.1893939393939394 / 1.9000000000000000 / 0.20000000000000000000 / 7.9893939393939394
--   service_type_configs.min_fare_usd
--     moto_standard 1.0000 · triciclo_basico 2.1008 · auto_standard 2.4902 · auto_confort 4.1398

-- ── Day bands: minimum fare (and the afternoon flag-fall) ──
UPDATE public.pricing_rules pr SET
  min_fare_usd  = v.min_fare / 720.0,
  base_fare_usd = COALESCE(v.base / 720.0, pr.base_fare_usd),
  updated_at    = now()
FROM (VALUES
  ('moto_standard',   '06:00:00'::time, NULL::int,  580),
  ('moto_standard',   '12:00:00'::time, 320,        580),
  ('triciclo_basico', '06:00:00'::time, NULL::int, 1250),
  ('triciclo_basico', '12:00:00'::time, 1070,      1250),
  ('auto_standard',   '06:00:00'::time, NULL::int, 1450),
  ('auto_standard',   '12:00:00'::time, 560,       1450)
) AS v(slug, win, base, min_fare)
WHERE pr.service_type = v.slug
  AND pr.time_window_start = v.win
  AND pr.is_active = true;

-- ── Confort = auto x1.3, all bands ──
UPDATE public.pricing_rules pr SET
  base_fare_usd       = v.base     / 720.0,
  per_km_rate_usd     = v.per_km   / 720.0,
  per_minute_rate_usd = v.per_min  / 720.0,
  min_fare_usd        = v.min_fare / 720.0,
  updated_at = now()
FROM (VALUES
  ('06:00:00'::time, 220, 1000, 40, 1880),
  ('12:00:00'::time, 730,  770,  0, 1880),
  ('18:00:00'::time, 420, 1030, 60, 2640),
  ('00:00:00'::time, 630, 1150, 90, 3390)
) AS v(win, base, per_km, per_min, min_fare)
WHERE pr.service_type = 'auto_confort'
  AND pr.time_window_start = v.win
  AND pr.is_active = true;

-- ── Fare floor checked by tg_rides_validate_estimated_fare ──
UPDATE public.service_type_configs sc SET
  min_fare_usd = v.min_fare / 720.0,
  updated_at   = now()
FROM (VALUES
  ('moto_standard',    580),
  ('triciclo_basico', 1250),
  ('auto_standard',   1450),
  ('auto_confort',    1880)
) AS v(slug, min_fare)
WHERE sc.slug = v.slug;

-- ── Derive every CUP column from the current rate (same path as the FX cron) ──
SELECT public.recompute_cup_from_usd_prices();

-- ── Assertions: abort the whole migration if anything did not land ──
DO $check$
DECLARE
  v_rate    numeric;
  v_rows    int;
  v_bad     text;
BEGIN
  -- Every targeted band exists and carries the new minimum (10 rule rows).
  SELECT count(*) INTO v_rows
  FROM public.pricing_rules pr
  JOIN (VALUES
    ('moto_standard',   '06:00:00'::time,  580),
    ('moto_standard',   '12:00:00'::time,  580),
    ('triciclo_basico', '06:00:00'::time, 1250),
    ('triciclo_basico', '12:00:00'::time, 1250),
    ('auto_standard',   '06:00:00'::time, 1450),
    ('auto_standard',   '12:00:00'::time, 1450),
    ('auto_confort',    '06:00:00'::time, 1880),
    ('auto_confort',    '12:00:00'::time, 1880),
    ('auto_confort',    '18:00:00'::time, 2640),
    ('auto_confort',    '00:00:00'::time, 3390)
  ) AS e(slug, win, min_fare)
    ON pr.service_type = e.slug AND pr.time_window_start = e.win AND pr.is_active
  WHERE round(pr.min_fare_usd * 720) = e.min_fare;
  IF v_rows <> 10 THEN
    RAISE EXCEPTION '00593: expected 10 updated bands, found %', v_rows;
  END IF;

  -- CUP columns were recomputed from the current rate.
  SELECT usd_cup_rate INTO v_rate FROM public.exchange_rates WHERE is_current LIMIT 1;
  IF v_rate IS NOT NULL THEN
    SELECT string_agg(service_type || ' ' || time_window_start, ', ') INTO v_bad
    FROM public.pricing_rules
    WHERE is_active
      AND service_type IN ('moto_standard','triciclo_basico','auto_standard','auto_confort')
      AND (min_fare_cup  <> round(min_fare_usd  * v_rate)
        OR base_fare_cup <> round(base_fare_usd * v_rate));
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION '00593: CUP not recomputed for %', v_bad;
    END IF;
  END IF;

  -- Floor invariant: no band's minimum may sit below the trigger's floor.
  SELECT string_agg(sc.slug, ', ') INTO v_bad
  FROM public.service_type_configs sc
  WHERE sc.slug IN ('moto_standard','triciclo_basico','auto_standard','auto_confort')
    AND sc.min_fare_cup > (SELECT min(pr.min_fare_cup) FROM public.pricing_rules pr
                           WHERE pr.service_type = sc.slug AND pr.is_active);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00593: fare floor above a band minimum for %', v_bad;
  END IF;
END
$check$;
