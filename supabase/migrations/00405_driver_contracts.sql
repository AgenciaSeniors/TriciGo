-- ============================================================
-- Migration 00405: Driver terms-acceptance contract
--
-- Business requirement: when a driver completes registration, a
-- contract PDF stating they accepted the Terms & Conditions must be
-- generated, emailed to the driver (Spanish) and to administration
-- (Spanish + Romanian — the operating company MACH DIGITAL TECH
-- S.R.L. is Romanian), and downloadable from the driver's profile
-- in the admin panel.
--
-- This migration ships the DB side:
--   1. driver_profiles.terms_accepted_at — set by the explicit
--      acceptance checkbox in the driver app (new builds). Older
--      builds don't send it; the EF falls back to submission time.
--   2. driver_contracts table (one contract per driver) + RLS.
--   3. generate_contract_no() — atomic 'CTR-YYYY-NNNNNN' (mirrors
--      generate_receipt_no from 00235).
--   4. Storage bucket `driver-contracts` (private, PDF only) + RLS.
--   5. Trigger on driver_profiles status -> 'under_review' that
--      calls the generate-driver-contract Edge Function (same
--      pattern as trg_notify_driver_under_review from 00138:
--      vault key, silent skip, never blocks onboarding).
--
-- The PDFs themselves are built by the Edge Function
-- supabase/functions/generate-driver-contract (pdf-lib).
-- ============================================================

-- 1. Acceptance timestamp set by the driver-app checkbox.
ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

COMMENT ON COLUMN driver_profiles.terms_accepted_at IS
  '00405: when the driver explicitly accepted the T&C in the onboarding checkbox. NULL for builds that predate the checkbox — the contract EF falls back to the submission time.';

-- 2. Contracts table — one row per driver.
CREATE TABLE IF NOT EXISTS driver_contracts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id         UUID NOT NULL UNIQUE REFERENCES driver_profiles(id) ON DELETE CASCADE,
  contract_no       TEXT NOT NULL UNIQUE,
  accepted_at       TIMESTAMPTZ NOT NULL,
  -- cms_content('terms').updated_at at generation time — pins WHICH
  -- version of the T&C the driver accepted.
  terms_updated_at  TIMESTAMPTZ,
  pdf_es_path       TEXT,
  pdf_ro_path       TEXT,
  emailed_driver_at TIMESTAMPTZ,
  emailed_admin_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE driver_contracts ENABLE ROW LEVEL SECURITY;

-- Driver reads their own contract; admins read all. Writes only via
-- the service-role EF (no INSERT/UPDATE policies for authenticated).
CREATE POLICY driver_contracts_driver_read
  ON driver_contracts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM driver_profiles dp
      WHERE dp.id = driver_contracts.driver_id
        AND dp.user_id = auth.uid()
    )
  );

CREATE POLICY driver_contracts_admin_read
  ON driver_contracts FOR SELECT
  USING (is_admin());

-- 3. Atomic contract-number generator: 'CTR-YYYY-NNNNNN'
CREATE SEQUENCE IF NOT EXISTS driver_contracts_seq START 1;

CREATE OR REPLACE FUNCTION public.generate_contract_no()
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  SELECT 'CTR-' || to_char(now(), 'YYYY') || '-' ||
         lpad(nextval('public.driver_contracts_seq'::regclass)::text, 6, '0');
$$;

GRANT EXECUTE ON FUNCTION public.generate_contract_no() TO service_role;
REVOKE EXECUTE ON FUNCTION public.generate_contract_no() FROM PUBLIC, authenticated, anon;

-- 4. Storage bucket — private, PDF only, 2 MB cap.
--    Path convention: {user_id}/{contract_no}-es.pdf / -ro.pdf
--    (first segment = users.id so the owner-read policy works).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('driver-contracts', 'driver-contracts', false, 2097152, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "driver_contracts_owner_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'driver-contracts'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "driver_contracts_service_write"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'driver-contracts'
    AND auth.role() = 'service_role'
  );

CREATE POLICY "driver_contracts_admin_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'driver-contracts'
    AND is_admin()
  );

-- 5. Trigger: generate the contract when the driver submits for
--    review (status -> 'under_review'). Same transition + same
--    defensive shape as trg_notify_driver_under_review (00138).
CREATE OR REPLACE FUNCTION public.generate_driver_contract_on_submit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_service_key TEXT;
  v_headers     JSONB;
BEGIN
  -- Only on transition INTO under_review
  IF NEW.status <> 'under_review' OR OLD.status = 'under_review' THEN
    RETURN NEW;
  END IF;

  -- Idempotency: the EF also checks, but skip the HTTP call entirely
  -- if a contract already exists (re-submission after rejection).
  IF EXISTS (SELECT 1 FROM driver_contracts WHERE driver_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;  -- No vault secret; skip silently.
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  PERFORM net.http_post(
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/generate-driver-contract',
    headers := v_headers,
    body    := jsonb_build_object('driver_id', NEW.id::text)
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;  -- Never block onboarding.
END;
$$;

DROP TRIGGER IF EXISTS trg_generate_driver_contract ON driver_profiles;
CREATE TRIGGER trg_generate_driver_contract
  AFTER UPDATE OF status ON driver_profiles
  FOR EACH ROW
  WHEN (NEW.status = 'under_review' AND OLD.status IS DISTINCT FROM 'under_review')
  EXECUTE FUNCTION public.generate_driver_contract_on_submit();

REVOKE EXECUTE ON FUNCTION public.generate_driver_contract_on_submit() FROM PUBLIC, authenticated, anon;

COMMENT ON FUNCTION public.generate_driver_contract_on_submit() IS
  '00405: fires the generate-driver-contract EF when a driver submits for review. Defensive — never blocks onboarding.';

-- ============================================================
-- Verification snippets (run manually after apply):
--
--   SELECT generate_contract_no();
--   -- expected: CTR-2026-000001 (consumes one sequence value)
--
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'driver_contracts';
--   -- expected: t
--
--   SELECT id, public, file_size_limit FROM storage.buckets
--    WHERE id = 'driver-contracts';
--   -- expected: (driver-contracts, false, 2097152)
--
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'driver_profiles'::regclass
--     AND tgname = 'trg_generate_driver_contract';
-- ============================================================
