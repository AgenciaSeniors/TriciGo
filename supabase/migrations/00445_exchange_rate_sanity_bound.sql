-- 00445_exchange_rate_sanity_bound.sql
-- Pre-launch audit 2026-06-20 — AUD-002 (P1) + AUD-020 (P3) + broken admin manual-rate path.
--
-- AUD-002: exchange_rates.usd_cup_rate had NO sanity bound. A typo (6950 vs 695) would
--   ×10 every stored fare via trg_exchange_rate_recompute_prices AND ×10 every anchored
--   wallet's CUP balance via the revalue-anchored-wallets cron (30 4 * * *). The [100,5000]
--   clamp lived ONLY in the sync-exchange-rate edge function (scraping path); upsert_exchange_rate
--   and the admin manual path had none. This adds the bound at the single DB chokepoint so
--   EVERY write path (EF, RPC, admin) is covered. Current rate 695, historical range 512..695
--   (n=2335) → all existing rows satisfy the bound; ADD CONSTRAINT validates cleanly.
--
-- AUD-020 + broken admin path: setManualRate did a non-atomic two-step (UPDATE is_current=false;
--   INSERT is_current=true). With the new CHECK, a rejected out-of-bound INSERT would leave
--   is_current=false orphaned (no current rate). Worse, exchange_rates RLS only has a SELECT
--   policy (er_select) and the admin app uses a USER JWT (getSupabaseClient, not service_role),
--   so the direct writes were RLS-denied — the admin manual-rate feature was effectively dead.
--   Fix: route setManualRate through upsert_exchange_rate (atomic UPDATE+INSERT in one txn, so a
--   CHECK rejection rolls back cleanly), add an is_admin() guard inside it, and GRANT EXECUTE to
--   authenticated. service_role (auth.uid() IS NULL, used by sync-exchange-rate EF) keeps access.

-- 1) AUD-002 — sanity bound on the rate (idempotent).
ALTER TABLE public.exchange_rates DROP CONSTRAINT IF EXISTS exchange_rates_usd_cup_rate_bound;
ALTER TABLE public.exchange_rates
  ADD CONSTRAINT exchange_rates_usd_cup_rate_bound
  CHECK (usd_cup_rate >= 100 AND usd_cup_rate <= 5000);

-- 2) AUD-020 + admin path — upsert_exchange_rate gains an is_admin() guard so the admin's
--    USER JWT can call it (atomic, RLS-independent), while non-admin authenticated callers are
--    rejected and service_role (auth.uid() IS NULL) keeps working for the scraping EF.
--    Signature unchanged → CREATE OR REPLACE (no overload). Body reproduced from the live
--    definition (pg_get_functiondef) + the guard.
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
BEGIN
  -- service_role (auth.uid() IS NULL, used by the sync-exchange-rate EF) and admins only.
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized to set exchange rate';
  END IF;

  UPDATE exchange_rates SET is_current = false WHERE is_current = true;
  INSERT INTO exchange_rates (source, usd_cup_rate, fetched_at, is_current)
  VALUES (p_source, p_usd_cup_rate, p_fetched_at, true);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.upsert_exchange_rate(text, numeric, timestamp with time zone) TO authenticated;
