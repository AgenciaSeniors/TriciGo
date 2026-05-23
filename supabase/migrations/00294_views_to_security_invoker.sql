-- ============================================================
-- ADV-01 (security audit 2026-05-23, Supabase advisor ERROR):
-- Two views in public schema are SECURITY DEFINER (default for
-- views created without explicit `WITH (security_invoker=true)`):
--
--   * `wallet_accounts_v2` — projects wallet_accounts with USD
--     denomination columns. Used by client apps to read their own
--     balance.
--   * `ride_audit_log` — projects rides as event-stream rows
--     (ride_created / driver_accepted / arrived_at_pickup / ...).
--     Used by admin tooling for forensic timelines.
--
-- Why SECURITY DEFINER on views is dangerous:
--
-- The view runs RLS checks under the view-owner's role (typically
-- `postgres`), bypassing the caller's RLS policies on the underlying
-- table. Today this is "safe by coincidence" — neither view has a
-- WHERE clause that filters by caller identity, and both underlying
-- tables (`wallet_accounts`, `rides`) DO have RLS — but the safety
-- is fragile:
--
--   * If anyone runs `GRANT SELECT ON wallet_accounts_v2 TO anon;`
--     in the future, every wallet balance becomes visible to anon.
--   * If a developer adds a new view column that references a
--     sensitive table column not currently exposed, the SECURITY
--     DEFINER context exposes it bypassing RLS.
--   * Supabase advisor flags this as ERROR (highest severity) for
--     this exact reason.
--
-- Fix: set `security_invoker = true` on both views. Now the view
-- runs RLS checks under the *caller's* role:
--
--   * `wallet_accounts.wa_select: user_id = auth.uid() OR is_admin()`
--     → invoker as customer only sees their own row via the view,
--       admin sees all (unchanged from current external behavior,
--       but enforced by the caller's policies instead of the view
--       owner's bypass).
--   * `rides.r_select_customer / r_select_driver / r_admin_select`
--     → invoker as customer sees rides where customer_id matches,
--       driver sees their assigned rides, admin sees all. The
--       audit log filters naturally.
--
-- Backward compat: external behavior IS UNCHANGED for legitimate
-- callers (admin tooling reads via service_role which bypasses RLS;
-- client apps query their own balance and that's what RLS allows).
-- Any caller relying on the SECURITY DEFINER bypass to see data
-- they shouldn't would break — that's the intended security fix.
--
-- No GRANT changes — existing privileges (SELECT to authenticated)
-- remain. The migration only changes the security context of view
-- evaluation.
--
-- Closes Supabase advisor `security_definer_view` × 2 (ERROR level).
-- ============================================================

-- ── wallet_accounts_v2 ──
-- The view projects USD-denominated wallet balances. Underlying
-- table wallet_accounts has wa_select policy that already filters
-- by user_id = auth.uid() OR is_admin(). After this ALTER, calling
-- the view respects that policy from the caller's context.
ALTER VIEW public.wallet_accounts_v2 SET (security_invoker = true);

COMMENT ON VIEW public.wallet_accounts_v2 IS
  'USD-denominated projection of wallet_accounts. SECURITY INVOKER (ADV-01 fix): the underlying wallet_accounts.wa_select RLS policy applies to the caller, not the view owner.';

-- ── ride_audit_log ──
-- The view projects rides as event-stream rows. Underlying table
-- rides has 4 SELECT policies (r_select_customer, r_select_driver,
-- r_admin_select, etc.). After this ALTER, the view filters to
-- exactly the rides the caller can SELECT directly.
ALTER VIEW public.ride_audit_log SET (security_invoker = true);

COMMENT ON VIEW public.ride_audit_log IS
  'Event-stream projection of rides for forensic timelines. SECURITY INVOKER (ADV-01 fix): underlying rides RLS policies (r_select_customer, r_select_driver, r_admin_select) apply to the caller.';
