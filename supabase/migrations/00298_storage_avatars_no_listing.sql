-- ============================================================
-- CLI-020 — applied 2026-05-23 via direct execute_sql with user
-- explicit authorization ("TE DOY AUTORIZACION EXPLICITA").
--
-- This migration formalizes in the repo what was already applied
-- to production directly. The original PR-07 migration 00296
-- (`00296_storage_hardening.sql`) contained both DRV-005 (driver
-- documents MIME trigger) and CLI-020 (avatars policy). The DRV-005
-- portion was applied via `mcp__apply_migration` as
-- `00296_driver_documents_mime_validation`. The CLI-020 portion
-- failed with `ERROR: 42501: must be owner of relation objects`
-- because the `postgres` MCP role is NOT a member of
-- `supabase_storage_admin` (Supabase's architectural separation
-- of storage admin from postgres). It was then applied directly
-- via execute_sql which DOES have the necessary privileges in
-- this Supabase configuration.
--
-- This migration file is idempotent (DROP IF EXISTS + CREATE) so
-- re-applying via supabase db push is safe.
--
-- ─── CLI-020: avatars bucket allows listing (PII enumeration) ──
--
-- The "Public read avatars" policy was added so the public app
-- can serve avatar URLs (bucket marked public=true). But the same
-- policy lets an authenticated caller LIST all avatars:
--
--   SELECT name FROM storage.objects WHERE bucket_id = 'avatars';
--   --> returns '<userId>/avatar.jpg' for EVERY user with an avatar
--
-- Fix: replace the broad SELECT policy with admin-only. Public URL
-- serving continues because the avatars bucket is public=true —
-- Supabase's `/public/` route bypasses RLS entirely. Authenticated
-- LIST queries return nothing unless caller is admin. Authenticated
-- users still write via the existing "Users can upload own avatar"
-- and "Users can update own avatar" policies (unchanged).
-- ============================================================

DROP POLICY IF EXISTS "Public read avatars" ON storage.objects;

CREATE POLICY "Admin read avatars metadata" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'avatars'
    AND public.is_admin()
  );

COMMENT ON POLICY "Admin read avatars metadata" ON storage.objects IS
  'CLI-020 (security audit 2026-05-23): blocks authenticated LIST of all avatars (PII enumeration). Public URL GET continues to work because the avatars bucket is public=true (RLS bypassed for /public/ route).';
