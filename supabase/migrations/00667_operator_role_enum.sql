-- ============================================================
-- 00667 — operator role: the enum value
--
-- Spec: docs/superpowers/specs/2026-10-25-operator-role-design.md
-- A value added by ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it
-- (same split as 00641/00642), so everything that uses 'operator' lives in 00668.
-- On its own this changes nothing: no account has the role until a super admin invites one.
-- ============================================================
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'operator';
