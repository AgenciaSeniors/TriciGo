-- ============================================================
-- 00641 — marketing role: the enum value
--
-- Spec: docs/superpowers/specs/2026-10-08-marketing-role-design.md
-- A value added by ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it
-- (same split as 00370/00371), so everything that uses 'marketing' lives in 00642.
-- On its own this changes nothing: no account has the role until a super_admin grants it with
-- promote_user_role.
-- ============================================================
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'marketing';
