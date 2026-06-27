-- 00469 — USD-anchor hardening (FX anchor audit, Tema F / PR-FX-6)
--
-- Defense-in-depth, no behavior change for the happy path:
--  1) CHECK constraints making anchor_usd_cents (when present) and unbacked_cup
--     non-negative at the schema level. Today the non-negativity is only enforced by
--     GREATEST(0, ...) inside the anchor trigger; a future write path that skips the
--     trigger could leave a negative value that the revaluation would then turn into
--     money. Pre-flight verified vs prod: 0 violations, so the constraints apply clean.
--  2) Seed anchor_usd_cents = 0 (not NULL) for newly created anchored wallets in
--     ensure_wallet_account, so the cron's `anchor_usd_cents IS NOT NULL` filter and the
--     state are uniform. Functionally equivalent to NULL today (the trigger COALESCEs
--     NULL->0), but removes the ambiguous NULL state. Non-anchored types stay NULL.

-- 1) Non-negativity CHECK constraints (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_anchor_usd_cents_nonneg'
      AND conrelid = 'public.wallet_accounts'::regclass
  ) THEN
    ALTER TABLE public.wallet_accounts
      ADD CONSTRAINT chk_anchor_usd_cents_nonneg
      CHECK (anchor_usd_cents IS NULL OR anchor_usd_cents >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_unbacked_cup_nonneg'
      AND conrelid = 'public.wallet_accounts'::regclass
  ) THEN
    ALTER TABLE public.wallet_accounts
      ADD CONSTRAINT chk_unbacked_cup_nonneg
      CHECK (unbacked_cup >= 0);
  END IF;
END $$;

-- 2) Seed anchor_usd_cents = 0 for new anchored wallets (verbatim live body + the seed).
CREATE OR REPLACE FUNCTION public.ensure_wallet_account(p_user_id uuid, p_type wallet_account_type DEFAULT 'customer_cash'::wallet_account_type)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_type;
  IF v_id IS NULL THEN
    INSERT INTO wallet_accounts (id, user_id, account_type, balance, held_balance, currency, anchor_usd_cents)
    VALUES (gen_random_uuid(), p_user_id, p_type, 0, 0, 'TRC',
            CASE WHEN p_type IN ('customer_cash', 'corporate_cash', 'tricicoin') THEN 0 ELSE NULL END)
    ON CONFLICT (user_id, account_type) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_type;
    END IF;
  END IF;
  RETURN v_id;
END;
$function$;
