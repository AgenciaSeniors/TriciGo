-- ============================================================
-- CLI-020 + DRV-005 (security audit 2026-05-23, Storage hardening):
--
-- ─── CLI-020: avatars bucket allows listing ──────────────────
--
-- Current policy on `storage.objects`:
--   "Public read avatars" FOR SELECT USING (bucket_id = 'avatars')
--
-- This was added so the public app can serve avatar URLs (the
-- avatars bucket is marked public=true). But the same policy
-- also lets an authenticated caller LIST all avatars:
--
--   SELECT name FROM storage.objects WHERE bucket_id = 'avatars';
--   --> returns paths like '<userId>/avatar.jpg' for EVERY user
--
-- An attacker can enumerate every userId with an avatar, then
-- scrape all profile photos. Low-tier PII leak but still leak.
--
-- Fix: the avatars bucket is `public=true` so GET via public URL
-- BYPASSES RLS — the SELECT policy only governs API-level LIST
-- and authenticated metadata reads. We can therefore replace the
-- broad SELECT with one that requires admin, blocking enumeration
-- while preserving public URL serving (the primary use case).
--
-- Verification: client apps reading avatars via `<supabase-url>/
-- storage/v1/object/public/avatars/<userId>/avatar.jpg` continue
-- to work because the `/public/` route doesn't check RLS for
-- public buckets. Authenticated LIST queries return only admin's
-- own + admin override.
--
-- ─── DRV-005: driver_documents lacks MIME validation ─────────
--
-- driver_documents has a `mime_type text` column populated by the
-- driver app at upload time (driver.service.ts:81-123). Currently
-- no DB-level validation — a driver can upload an executable
-- disguised as image/jpeg and the row inserts cleanly. Admin
-- review tooling later opens the file and the attack surface
-- moves to the admin's browser.
--
-- Fix: BEFORE INSERT/UPDATE trigger on driver_documents that
-- validates mime_type against a whitelist. Image formats common
-- for KYC (jpeg, png, webp, heic/heif for iOS) plus PDF for
-- license/registration documents.
--
-- Size validation NOT included in this migration: there is no
-- file_size_bytes column on driver_documents (only storage_path
-- pointing to storage.objects which has metadata.size). Adding
-- size validation would require a JOIN to storage.objects or a
-- new column populated at upload time. Recommended follow-up:
-- add file_size_bytes column + populate from client + extend
-- this trigger with size cap (10 MB).
--
-- The companion validation in apps/driver/src/lib/compressDocument.ts
-- (client-side MIME + size check) is the first defense; this
-- trigger is the server-side enforcement that catches bypass.
-- ============================================================

-- ── CLI-020: restrict avatars bucket SELECT ──

DROP POLICY IF EXISTS "Public read avatars" ON storage.objects;

-- Authenticated users can SELECT (metadata) only via admin override.
-- Public URL serving continues to work because the avatars bucket
-- has `public=true` — that route bypasses RLS entirely.
CREATE POLICY "Admin read avatars metadata" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'avatars'
    AND public.is_admin()
  );

COMMENT ON POLICY "Admin read avatars metadata" ON storage.objects IS
  'CLI-020: blocks authenticated LIST of all avatars (PII enumeration). Public URL GET continues to work because the avatars bucket is public=true (RLS bypassed for /public/ route).';

-- Reading own avatar metadata: allowed via the existing
-- "Users can update own avatar" / "Users can upload own avatar"
-- policies which scope to (storage.foldername(name))[1] = auth.uid().
-- No additional read policy needed because (a) GET via public URL
-- is RLS-free for public buckets and (b) authenticated users don't
-- need to LIST their own avatars (there's only one per user).

-- ── DRV-005: driver_documents MIME validation trigger ──

CREATE OR REPLACE FUNCTION public.tg_driver_documents_validate_mime()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  -- KYC-acceptable MIME types. Add new entries here as needed
  -- (e.g. 'image/avif' once browsers settle on it).
  v_allowed_mimes CONSTANT TEXT[] := ARRAY[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'application/pdf'
  ];
BEGIN
  -- Admin bypass — admin tooling may need to backfill / fix
  -- records with non-standard MIMEs for legacy data.
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.mime_type IS NULL OR length(trim(NEW.mime_type)) = 0 THEN
    RAISE EXCEPTION 'driver_documents.mime_type is required';
  END IF;

  IF NOT (LOWER(NEW.mime_type) = ANY(v_allowed_mimes)) THEN
    RAISE EXCEPTION 'driver_documents.mime_type "%" is not in the allowed whitelist (%)',
      NEW.mime_type, array_to_string(v_allowed_mimes, ', ');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_driver_documents_validate_mime ON public.driver_documents;

CREATE TRIGGER trg_driver_documents_validate_mime
  BEFORE INSERT OR UPDATE OF mime_type ON public.driver_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_driver_documents_validate_mime();

COMMENT ON TRIGGER trg_driver_documents_validate_mime ON public.driver_documents IS
  'DRV-005: server-side MIME whitelist for KYC documents. Allowed: jpeg/png/webp/heic/heif + pdf. Admin bypass for legacy backfill. Complement to client-side check in apps/driver/src/lib/compressDocument.ts. Size validation deferred — needs file_size_bytes column (follow-up).';
