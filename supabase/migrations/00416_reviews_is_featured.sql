-- 00416_reviews_is_featured.sql
-- ============================================================================
-- Found by the client↔schema column-contract sweep (2026-06-13): the admin
-- reviews panel (apps/admin/src/app/reviews/page.tsx) has a fully-built
-- "Destacar reseña" (feature review) toggle — a star button, success/error
-- toasts, an is_featured row field, and a star indicator in the table — but the
-- `reviews` table has NO `is_featured` column. So handleToggleFeatured's
-- `.from('reviews').update({ is_featured })` fails at runtime with
-- "column reviews.is_featured does not exist", and every click shows an error
-- toast. The untyped Supabase client (getSupabaseClient has no <Database>
-- generic) hides this from tsc.
--
-- Fix: add the column so the existing admin curation UI works end-to-end. It is
-- admin-only by RLS — the only UPDATE policy on reviews is `rev_admin`
-- (USING is_admin()); there is no self-update policy, so a reviewer cannot set
-- is_featured on their own review. DEFAULT false, NOT NULL, idempotent.
-- ============================================================================

ALTER TABLE public.reviews
  ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.reviews.is_featured IS
  'Admin curation flag (admin-only via RLS rev_admin). Powers the "Destacar reseña" toggle + star indicator in the admin reviews panel. Added 00416.';
