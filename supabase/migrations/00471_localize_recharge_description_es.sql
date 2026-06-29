-- 00471_localize_recharge_description_es.sql
-- Localize the wallet-recharge ledger description to Spanish.
--
-- Context: process_recharge_payment is the RPC that credits a wallet once a
-- NETOPIA / Stripe payment succeeds (it is called from the
-- process-netopia-webhook Edge Function). It writes
-- ledger_transactions.description in ENGLISH, e.g.
--   "NETOPIA wallet recharge: 13600 CUP (~$20.00 USD)"
-- and that text is shown verbatim in the user's wallet history
-- ("Créditos de viaje" / "Crédito de comisión"). The whole app UI is Spanish,
-- so the English string is the only out-of-place copy on that screen. This
-- migration localizes the FIXED text while keeping the provider label and the
-- amount/currency, producing:
--   "Recarga vía NETOPIA: 13600 CUP (~$20.00 USD)"
-- (the provider label is also "Stripe" / "EuPlatesc" / "TropiPay" for those
-- providers — localizing the shared string covers all of them).
--
-- Safe by construction:
--   * The recharge idempotency_key is computed elsewhere and does NOT include
--     the description, so a duplicate webhook still no-ops on the existing
--     ledger_transactions row — idempotency is unaffected.
--   * Nothing parses the amount out of this string: generate-recharge-receipt
--     reads amount_usd / amount_cup from payment_intents, and the wallet UI
--     renders `description` raw. Only display text changes.
--
-- Applied as an in-place patch (read the LIVE function body, swap one fragment)
-- per the "patch in-place for one-line changes in large RPCs" pattern in
-- CLAUDE.md: process_recharge_payment is large and has been redefined by
-- several CREATE OR REPLACE migrations (00282/00284/00293/00300) plus later
-- FX-anchor work, so reproducing the whole body verbatim risks silently
-- dropping a feature (cf. the 00124 regression). Patching the live body cannot
-- lose features. The patch is idempotent and a no-op when the function is
-- absent or already localized.

DO $patch$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p
  WHERE p.proname = 'process_recharge_payment'
    AND p.pronamespace = 'public'::regnamespace;

  IF v_src IS NULL THEN
    RAISE NOTICE 'process_recharge_payment absent; skipping localization';
    RETURN;
  END IF;

  -- Idempotent: skip if a previous run already localized the description.
  IF position($find$'Recarga vía ' || v_provider_label$find$ IN v_src) > 0 THEN
    RAISE NOTICE 'process_recharge_payment description already localized; skipping';
    RETURN;
  END IF;

  -- Bail loudly if the English fragment is missing (body changed shape) so a
  -- human reviews rather than the patch silently doing nothing.
  IF position($find$v_provider_label || ' wallet recharge: ' || v_intent.amount_cup$find$ IN v_src) = 0 THEN
    RAISE NOTICE 'process_recharge_payment recharge-description fragment not found; skipping (needs manual review)';
    RETURN;
  END IF;

  EXECUTE replace(
    v_src,
    $find$v_provider_label || ' wallet recharge: ' || v_intent.amount_cup$find$,
    $repl$'Recarga vía ' || v_provider_label || ': ' || v_intent.amount_cup$repl$
  );

  RAISE NOTICE 'process_recharge_payment recharge description localized to Spanish';
END $patch$;
