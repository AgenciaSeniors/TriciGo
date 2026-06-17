-- 00441_usd_anchored_pricing.sql
--
-- USD-anchored pricing. Supersedes 00440 (which only set CUP "Medio" values).
--
-- WHY: TriciGo charges in CUP in a high-inflation economy. With prices stored
-- purely in CUP, every CUP devaluation erodes our real (USD) revenue and forces
-- manual edits. We make USD the source of truth and keep the CUP columns as a
-- derived cache that auto-recomputes whenever the current FX rate changes. The
-- rider keeps seeing CUP (and TRC, 1:1) exactly as before — but the CUP now
-- floats with the ElToque rate, protecting our USD revenue automatically.
--
-- HOW (low risk: the fare engine is NOT touched):
--   • Add *_usd columns to service_type_configs and pricing_rules (truth).
--   • recompute_cup_from_usd_prices(): CUP = ROUND(usd * current_rate).
--   • Trigger on exchange_rates (is_current -> true) calls it, so every rate
--     change (EF sync, upsert_exchange_rate RPC, admin setManualRate) refreshes
--     CUP. The estimate keeps reading CUP columns unchanged.
--
-- PRICE LEVEL (confirmed with the business owner 2026-06-17):
--   Derived from the "Análisis de Tarifas Taxi Cuba" report (app "la nave").
--   Report prices are GROSS (include la nave's ~20% commission), so:
--       neto      = report * 0.80          (strip la nave's 20%)
--       our_price = neto / 0.85            (re-apply our 15% commission split)
--                 = report * 0.9412
--   USD anchor    = our_price_CUP / 680    (ElToque rate on 2026-06-17)
--   Bands (flat): Día = base, Noche = Día*1.5, Madrugada = Día*2.
--   Surge stays weather-only (00375/00376) — no time-band surge.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; UPDATEs by slug / (service_type+window).
-- Does not change row ids -> ride_pricing_snapshots.pricing_rule_id stay valid.
-- Strict parity (snapshot.total = estimated_fare_cup) protects in-flight rides.

-- ─────────────────────────────────────────────────────────────────────────
-- 1) USD anchor columns (source of truth)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.service_type_configs
  ADD COLUMN IF NOT EXISTS base_fare_usd            numeric,
  ADD COLUMN IF NOT EXISTS per_km_rate_usd          numeric,
  ADD COLUMN IF NOT EXISTS per_minute_rate_usd      numeric,
  ADD COLUMN IF NOT EXISTS min_fare_usd             numeric,
  ADD COLUMN IF NOT EXISTS per_wait_minute_rate_usd numeric;

ALTER TABLE public.pricing_rules
  ADD COLUMN IF NOT EXISTS base_fare_usd       numeric,
  ADD COLUMN IF NOT EXISTS per_km_rate_usd     numeric,
  ADD COLUMN IF NOT EXISTS per_minute_rate_usd numeric,
  ADD COLUMN IF NOT EXISTS min_fare_usd        numeric;

COMMENT ON COLUMN public.service_type_configs.base_fare_usd IS
  '00441 USD anchor (source of truth). CUP columns are derived = ROUND(usd*rate) by recompute_cup_from_usd_prices().';
COMMENT ON COLUMN public.pricing_rules.base_fare_usd IS
  '00441 USD anchor (source of truth). CUP columns are derived by recompute_cup_from_usd_prices().';

-- ─────────────────────────────────────────────────────────────────────────
-- 2) Generic anchor: usd = current_cup / 680 for EVERY row (keeps current
--    level for anything not in the report: mensajeria, triciclo_premium, …).
--    The report vehicles are overridden right after.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.service_type_configs SET
  base_fare_usd            = base_fare_cup            / 680.0,
  per_km_rate_usd          = per_km_rate_cup          / 680.0,
  per_minute_rate_usd      = per_minute_rate_cup      / 680.0,
  min_fare_usd             = min_fare_cup             / 680.0,
  per_wait_minute_rate_usd = COALESCE(per_wait_minute_rate_cup, 0) / 680.0;

UPDATE public.pricing_rules SET
  base_fare_usd       = base_fare_cup       / 680.0,
  per_km_rate_usd     = per_km_rate_cup     / 680.0,
  per_minute_rate_usd = per_minute_rate_cup / 680.0,
  min_fare_usd        = min_fare_cup        / 680.0;

-- ─────────────────────────────────────────────────────────────────────────
-- 3) service_type_configs — Día defaults for the 4 report vehicles
--    (report * 0.80 / 0.85, then / 680). per_wait keeps the generic anchor.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.service_type_configs SET
  base_fare_usd = 1174/680.0, per_km_rate_usd = 314/680.0, per_minute_rate_usd = 11/680.0, min_fare_usd = 2798/680.0
WHERE slug = 'moto_standard';

UPDATE public.service_type_configs SET
  base_fare_usd = 1413/680.0, per_km_rate_usd = 422/680.0, per_minute_rate_usd = 16/680.0, min_fare_usd = 4227/680.0
WHERE slug = 'triciclo_basico';

UPDATE public.service_type_configs SET
  base_fare_usd = 4470/680.0, per_km_rate_usd = 1055/680.0, per_minute_rate_usd = 27/680.0, min_fare_usd = 8259/680.0
WHERE slug = 'auto_standard';

UPDATE public.service_type_configs SET
  base_fare_usd = 4237/680.0, per_km_rate_usd = 1126/680.0, per_minute_rate_usd = 38/680.0, min_fare_usd = 9644/680.0
WHERE slug = 'auto_confort';

-- Keep inactive triciclo_premium aligned with triciclo_basico Día (sane if re-enabled).
UPDATE public.service_type_configs SET
  base_fare_usd = 1413/680.0, per_km_rate_usd = 422/680.0, per_minute_rate_usd = 16/680.0, min_fare_usd = 4227/680.0
WHERE slug = 'triciclo_premium';

-- ─────────────────────────────────────────────────────────────────────────
-- 4) pricing_rules — per-band USD anchors for the 4 report vehicles.
--    Día = 06-12 & 12-18 ; Noche = 18-00 (Día*1.5) ; Madrugada = 00-06 (Día*2).
-- ─────────────────────────────────────────────────────────────────────────

-- ── Moto (Día 1174 / 314 / 11 / 2798) ─────────────────────────────────────
UPDATE public.pricing_rules SET base_fare_usd=1174/680.0, per_km_rate_usd=314/680.0, per_minute_rate_usd=11/680.0, min_fare_usd=2798/680.0
  WHERE service_type='moto_standard' AND time_window_start='06:00:00' AND time_window_end='12:00:00';
UPDATE public.pricing_rules SET base_fare_usd=1174/680.0, per_km_rate_usd=314/680.0, per_minute_rate_usd=11/680.0, min_fare_usd=2798/680.0
  WHERE service_type='moto_standard' AND time_window_start='12:00:00' AND time_window_end='18:00:00';
UPDATE public.pricing_rules SET base_fare_usd=1174*1.5/680.0, per_km_rate_usd=314*1.5/680.0, per_minute_rate_usd=11*1.5/680.0, min_fare_usd=2798*1.5/680.0
  WHERE service_type='moto_standard' AND time_window_start='18:00:00' AND time_window_end='00:00:00';
UPDATE public.pricing_rules SET base_fare_usd=1174*2/680.0, per_km_rate_usd=314*2/680.0, per_minute_rate_usd=11*2/680.0, min_fare_usd=2798*2/680.0
  WHERE service_type='moto_standard' AND time_window_start='00:00:00' AND time_window_end='06:00:00';

-- ── Triciclo (Día 1413 / 422 / 16 / 4227) ─────────────────────────────────
UPDATE public.pricing_rules SET base_fare_usd=1413/680.0, per_km_rate_usd=422/680.0, per_minute_rate_usd=16/680.0, min_fare_usd=4227/680.0
  WHERE service_type='triciclo_basico' AND time_window_start='06:00:00' AND time_window_end='12:00:00';
UPDATE public.pricing_rules SET base_fare_usd=1413/680.0, per_km_rate_usd=422/680.0, per_minute_rate_usd=16/680.0, min_fare_usd=4227/680.0
  WHERE service_type='triciclo_basico' AND time_window_start='12:00:00' AND time_window_end='18:00:00';
UPDATE public.pricing_rules SET base_fare_usd=1413*1.5/680.0, per_km_rate_usd=422*1.5/680.0, per_minute_rate_usd=16*1.5/680.0, min_fare_usd=4227*1.5/680.0
  WHERE service_type='triciclo_basico' AND time_window_start='18:00:00' AND time_window_end='00:00:00';
UPDATE public.pricing_rules SET base_fare_usd=1413*2/680.0, per_km_rate_usd=422*2/680.0, per_minute_rate_usd=16*2/680.0, min_fare_usd=4227*2/680.0
  WHERE service_type='triciclo_basico' AND time_window_start='00:00:00' AND time_window_end='06:00:00';

-- ── Auto standard (Día 4470 / 1055 / 27 / 8259) ───────────────────────────
UPDATE public.pricing_rules SET base_fare_usd=4470/680.0, per_km_rate_usd=1055/680.0, per_minute_rate_usd=27/680.0, min_fare_usd=8259/680.0
  WHERE service_type='auto_standard' AND time_window_start='06:00:00' AND time_window_end='12:00:00';
UPDATE public.pricing_rules SET base_fare_usd=4470/680.0, per_km_rate_usd=1055/680.0, per_minute_rate_usd=27/680.0, min_fare_usd=8259/680.0
  WHERE service_type='auto_standard' AND time_window_start='12:00:00' AND time_window_end='18:00:00';
UPDATE public.pricing_rules SET base_fare_usd=4470*1.5/680.0, per_km_rate_usd=1055*1.5/680.0, per_minute_rate_usd=27*1.5/680.0, min_fare_usd=8259*1.5/680.0
  WHERE service_type='auto_standard' AND time_window_start='18:00:00' AND time_window_end='00:00:00';
UPDATE public.pricing_rules SET base_fare_usd=4470*2/680.0, per_km_rate_usd=1055*2/680.0, per_minute_rate_usd=27*2/680.0, min_fare_usd=8259*2/680.0
  WHERE service_type='auto_standard' AND time_window_start='00:00:00' AND time_window_end='06:00:00';

-- ── Auto confort (Día 4237 / 1126 / 38 / 9644) ────────────────────────────
UPDATE public.pricing_rules SET base_fare_usd=4237/680.0, per_km_rate_usd=1126/680.0, per_minute_rate_usd=38/680.0, min_fare_usd=9644/680.0
  WHERE service_type='auto_confort' AND time_window_start='06:00:00' AND time_window_end='12:00:00';
UPDATE public.pricing_rules SET base_fare_usd=4237/680.0, per_km_rate_usd=1126/680.0, per_minute_rate_usd=38/680.0, min_fare_usd=9644/680.0
  WHERE service_type='auto_confort' AND time_window_start='12:00:00' AND time_window_end='18:00:00';
UPDATE public.pricing_rules SET base_fare_usd=4237*1.5/680.0, per_km_rate_usd=1126*1.5/680.0, per_minute_rate_usd=38*1.5/680.0, min_fare_usd=9644*1.5/680.0
  WHERE service_type='auto_confort' AND time_window_start='18:00:00' AND time_window_end='00:00:00';
UPDATE public.pricing_rules SET base_fare_usd=4237*2/680.0, per_km_rate_usd=1126*2/680.0, per_minute_rate_usd=38*2/680.0, min_fare_usd=9644*2/680.0
  WHERE service_type='auto_confort' AND time_window_start='00:00:00' AND time_window_end='06:00:00';

-- ─────────────────────────────────────────────────────────────────────────
-- 5) recompute_cup_from_usd_prices(): CUP = ROUND(usd * current_rate)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recompute_cup_from_usd_prices()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
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
    updated_at = now()
  WHERE base_fare_usd IS NOT NULL;
END;
$$;

COMMENT ON FUNCTION public.recompute_cup_from_usd_prices() IS
  '00441 Refreshes the derived CUP price columns from the USD anchors using the current exchange rate. Called by the exchange_rates trigger on every rate change.';

-- ─────────────────────────────────────────────────────────────────────────
-- 6) Trigger: refresh CUP whenever the current FX rate changes
--    (covers EF sync, upsert_exchange_rate RPC, and admin setManualRate).
--    Defensive: a recompute failure must NEVER block a rate update.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_exchange_rate_recompute_prices()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.is_current = true THEN
    BEGIN
      PERFORM public.recompute_cup_from_usd_prices();
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'recompute_cup_from_usd_prices failed: % %', SQLSTATE, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_exchange_rate_recompute_prices ON public.exchange_rates;
CREATE TRIGGER trg_exchange_rate_recompute_prices
  AFTER INSERT OR UPDATE OF is_current ON public.exchange_rates
  FOR EACH ROW
  WHEN (NEW.is_current = true)
  EXECUTE FUNCTION public.tg_exchange_rate_recompute_prices();

-- ─────────────────────────────────────────────────────────────────────────
-- 7) Materialize CUP now from the USD anchors at the current rate.
-- ─────────────────────────────────────────────────────────────────────────
SELECT public.recompute_cup_from_usd_prices();
