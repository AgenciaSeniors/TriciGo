-- ============================================================
-- Wallet v2 — PR 1/9: receipts table + storage bucket
-- ============================================================
-- Spec: docs/WALLET_V2_USD_MODEL.md (sections §3.2, §3.3)
--
-- Introduces the legal receipt layer for Stripe wallet recharges.
-- One row per Stripe recharge, with USD/CUP snapshot and pointer
-- to a generated PDF stored in the new private bucket "receipts".
--
-- This migration is non-blocking: no existing tables are modified
-- and no existing flow depends on the new objects yet. Subsequent
-- PRs (edge function generate-recharge-receipt, webhook hook,
-- client UI) will populate the table.
-- ============================================================

-- 1. wallet_receipts table
CREATE TABLE wallet_receipts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id),
  payment_intent_id        uuid NOT NULL REFERENCES payment_intents(id) UNIQUE,
  receipt_no               text NOT NULL UNIQUE,
  -- amounts (USD, paridad 1 TC = 1 USD)
  usd_charged              numeric(10,2) NOT NULL,
  fee_usd                  numeric(10,2) NOT NULL DEFAULT 0,
  net_usd                  numeric(10,2) NOT NULL,
  tc_credited              numeric(10,2) NOT NULL,
  -- exchange-rate snapshot at recharge time
  exchange_rate            numeric(10,2) NOT NULL,
  exchange_at              timestamptz   NOT NULL,
  cup_equivalent           numeric(12,2) NOT NULL,
  -- payment method
  stripe_payment_intent_id text NOT NULL,
  card_brand               text,
  card_last4               text,
  -- pdf
  pdf_storage_path         text,
  pdf_generated_at         timestamptz,
  email_sent_at_user       timestamptz,
  email_sent_at_admin      timestamptz,
  -- audit
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wallet_receipts_user_created
  ON wallet_receipts (user_id, created_at DESC);

CREATE INDEX idx_wallet_receipts_payment_intent
  ON wallet_receipts (payment_intent_id);

-- 2. Atomic receipt-number generator: 'TG-YYYY-NNNNNN'
CREATE SEQUENCE wallet_receipts_seq START 1;

CREATE OR REPLACE FUNCTION public.generate_receipt_no()
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  SELECT 'TG-' || to_char(now(), 'YYYY') || '-' ||
         lpad(nextval('public.wallet_receipts_seq'::regclass)::text, 6, '0');
$$;

GRANT EXECUTE ON FUNCTION public.generate_receipt_no() TO service_role;

-- 3. RLS — users see only their own; admins see all
ALTER TABLE wallet_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY wallet_receipts_user_read
  ON wallet_receipts FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY wallet_receipts_admin_all
  ON wallet_receipts FOR ALL
  USING (is_admin());

-- 4. Storage bucket "receipts" — private, 1 MB cap, PDF only
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('receipts', 'receipts', false, 1048576, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- 5. Storage RLS — owner reads own folder, service_role writes, admin reads all
CREATE POLICY "receipts_owner_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'receipts'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "receipts_service_write"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'receipts'
    AND auth.role() = 'service_role'
  );

CREATE POLICY "receipts_admin_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'receipts'
    AND is_admin()
  );

-- ============================================================
-- Verification snippets (run manually after apply):
--
--   SELECT generate_receipt_no();
--   -- expected: TG-2026-000001
--
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'wallet_receipts';
--   -- expected: t
--
--   SELECT id, public, file_size_limit FROM storage.buckets
--    WHERE id = 'receipts';
--   -- expected: (receipts, false, 1048576)
-- ============================================================
