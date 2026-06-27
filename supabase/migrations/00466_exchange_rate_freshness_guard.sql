-- 00466 — Exchange-rate freshness + sanity hardening (FX anchor audit, Tema A / PR-FX-1)
--
-- Context: the USD anchor (revaluation cron + per-credit anchor trigger) and trip/
-- referral pricing all read the live USD→CUP rate via get_current_exchange_rate().
-- Two latent risks (verified against prod 2026-06-27):
--   1) get_current_exchange_rate() never checked freshness. If the eltoque feed
--      breaks, sync-exchange-rate returns early WITHOUT touching the is_current row,
--      so a stale rate is used indefinitely (prod has seen an 83.78h gap).
--   2) The emergency fallback exchange_rate_fallback_cup was 520, ~19% below the live
--      rate (640). If the is_current row ever disappears, every anchored wallet would
--      be revalued to ROUND(anchor/100*520) — a global ~19% haircut.
--
-- Design (deliberately NOT "return NULL globally"): get_current_exchange_rate() feeds
-- 8 callers including complete_ride_and_pay and referral rewards. Returning NULL there
-- is fragile (only safe today because cup_to_trc_centavos ignores the rate) and, in the
-- anchor TRIGGER, skipping on a credit would leave balance>anchor → the next revaluation
-- would delete the credit. So:
--   * get_current_exchange_rate(): NEVER NULL; fall back to the LAST-KNOWN rate (not the
--     stale 520). Keeps pricing / referral / email / anchor-trigger working and in sync.
--   * get_fresh_exchange_rate(): NEW strict accessor — NULL when the current rate is
--     stale. Used ONLY by revalue_anchored_wallets(), which already skips on NULL
--     (RETURN 0) without desyncing balance vs anchor.
--   * upsert_exchange_rate(): jump guard on the automated path (rejects a glitchy
--     >max_jump_pct step vs a FRESH baseline); admins bypass to confirm real moves.
--
-- All changes are CREATE OR REPLACE of small functions (full bodies reproduced verbatim
-- from the live prod definitions) or a guarded in-place patch; no behavior is lost.

-- 1) Config knobs (idempotent) + bump the stale fallback to the latest known rate.
INSERT INTO public.platform_config (key, value) VALUES
  ('exchange_rate_max_age_hours', '24'::jsonb),
  ('exchange_rate_max_jump_pct', '0.25'::jsonb)
ON CONFLICT (key) DO NOTHING;

UPDATE public.platform_config
   SET value = to_jsonb(COALESCE(
         (SELECT usd_cup_rate FROM public.exchange_rates ORDER BY fetched_at DESC LIMIT 1),
         640)::numeric)
 WHERE key = 'exchange_rate_fallback_cup';

-- 2) get_current_exchange_rate(): never NULL; last-known fallback instead of stale 520.
CREATE OR REPLACE FUNCTION public.get_current_exchange_rate()
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE v_rate NUMERIC;
BEGIN
  SELECT usd_cup_rate INTO v_rate
  FROM exchange_rates
  WHERE is_current = true
  LIMIT 1;

  -- No current row → most recent known rate, then config fallback, then 640.
  -- (Last-known beats the hardcoded floor so a missing is_current never undervalues.)
  IF v_rate IS NULL THEN
    SELECT usd_cup_rate INTO v_rate
    FROM exchange_rates
    ORDER BY fetched_at DESC
    LIMIT 1;
  END IF;

  IF v_rate IS NULL THEN
    SELECT (value #>> '{}')::NUMERIC INTO v_rate
    FROM platform_config WHERE key = 'exchange_rate_fallback_cup';
    v_rate := COALESCE(v_rate, 640.0);
  END IF;

  RETURN v_rate;
END;
$function$;

-- 3) get_fresh_exchange_rate(): strict — NULL when the current rate is stale.
CREATE OR REPLACE FUNCTION public.get_fresh_exchange_rate()
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_rate    NUMERIC;
  v_fetched TIMESTAMPTZ;
  v_max_age NUMERIC;
BEGIN
  SELECT usd_cup_rate, fetched_at INTO v_rate, v_fetched
  FROM exchange_rates
  WHERE is_current = true
  LIMIT 1;

  IF v_rate IS NULL OR v_fetched IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT (value #>> '{}')::NUMERIC INTO v_max_age
  FROM platform_config WHERE key = 'exchange_rate_max_age_hours';
  v_max_age := COALESCE(v_max_age, 24);

  IF v_max_age > 0 AND v_fetched < (now() - make_interval(hours => v_max_age::int)) THEN
    RAISE WARNING 'get_fresh_exchange_rate: is_current rate stale (fetched_at=%, max_age hours=%) -> NULL',
      v_fetched, v_max_age;
    RETURN NULL;
  END IF;

  RETURN v_rate;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_fresh_exchange_rate() TO anon, authenticated, service_role;

-- 4) revalue_anchored_wallets(): patch in-place to use the strict accessor.
--    It already does RAISE WARNING + RETURN 0 when the rate is NULL/<=0, so a stale
--    feed now SKIPS the daily revaluation (balance and anchor stay in sync) instead of
--    revaluing against a frozen value.
DO $patch$
DECLARE v_src text;
BEGIN
  v_src := pg_get_functiondef('public.revalue_anchored_wallets()'::regprocedure);
  IF v_src IS NOT NULL
     AND position('public.get_current_exchange_rate()' IN v_src) > 0
     AND position('get_fresh_exchange_rate' IN v_src) = 0 THEN
    EXECUTE replace(v_src, 'public.get_current_exchange_rate()', 'public.get_fresh_exchange_rate()');
    RAISE NOTICE '00466: revalue_anchored_wallets now uses get_fresh_exchange_rate()';
  ELSE
    RAISE NOTICE '00466: revalue_anchored_wallets already patched or call not found; skipping';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00466: revalue_anchored_wallets absent; skipping';
END $patch$;

-- 5) upsert_exchange_rate(): keep the existing authz + add a jump guard on the
--    automated (service_role / EF) path. A parse glitch within [100,5000] would
--    otherwise become is_current and propagate to anchoring/revaluation. Admins
--    (manual override) bypass so a genuine large move can be confirmed by a human.
CREATE OR REPLACE FUNCTION public.upsert_exchange_rate(
  p_source text,
  p_usd_cup_rate numeric,
  p_fetched_at timestamp with time zone
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_is_admin    boolean := false;
  v_cur         numeric;
  v_cur_fetched timestamptz;
  v_max_jump    numeric;
  v_max_age     numeric;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    v_is_admin := public.is_admin();
    IF NOT v_is_admin THEN
      RAISE EXCEPTION 'not authorized to set exchange rate';
    END IF;
  END IF;

  -- Sanity bound (mirrors the table CHECK from 00445).
  IF p_usd_cup_rate IS NULL OR p_usd_cup_rate < 100 OR p_usd_cup_rate > 5000 THEN
    RAISE EXCEPTION 'exchange rate % out of sane range [100,5000]', p_usd_cup_rate;
  END IF;

  -- Jump guard (automated path only; admins bypass). Only compares against a FRESH
  -- baseline — after a long feed outage the first new rate may legitimately differ a
  -- lot, so a stale baseline does not block recovery.
  IF NOT v_is_admin THEN
    SELECT usd_cup_rate, fetched_at INTO v_cur, v_cur_fetched
    FROM exchange_rates WHERE is_current = true LIMIT 1;

    SELECT (value #>> '{}')::numeric INTO v_max_jump
    FROM platform_config WHERE key = 'exchange_rate_max_jump_pct';
    v_max_jump := COALESCE(v_max_jump, 0.25);

    SELECT (value #>> '{}')::numeric INTO v_max_age
    FROM platform_config WHERE key = 'exchange_rate_max_age_hours';
    v_max_age := COALESCE(v_max_age, 24);

    IF v_cur IS NOT NULL AND v_cur > 0 AND v_max_jump > 0
       AND v_cur_fetched IS NOT NULL
       AND v_cur_fetched > (now() - make_interval(hours => v_max_age::int))
       AND abs(p_usd_cup_rate - v_cur) / v_cur > v_max_jump THEN
      RAISE EXCEPTION 'exchange rate jump too large: % -> %; limit is % percent. Rejected (set manually if real).',
        v_cur, p_usd_cup_rate, round(v_max_jump * 100, 1);
    END IF;
  END IF;

  UPDATE exchange_rates SET is_current = false WHERE is_current = true;
  INSERT INTO exchange_rates (source, usd_cup_rate, fetched_at, is_current)
  VALUES (p_source, p_usd_cup_rate, p_fetched_at, true);
END;
$function$;
