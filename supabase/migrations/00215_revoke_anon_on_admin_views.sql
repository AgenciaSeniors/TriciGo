-- ============================================================
-- BUG-193 (low / defense in depth): the views `eligible_drivers`
-- and `driver_churn_risk` are admin-internal aggregations
-- (churn risk score, financial earnings, internal driver
-- ratings) but are GRANTed SELECT to anon and authenticated.
--
-- The views are SECURITY INVOKER, so the underlying RLS on
-- driver_profiles DENIES anon access at runtime. Functionally
-- safe today. But the GRANT is misleading and a future RLS
-- policy regression could expose the data.
--
-- Fix: revoke from anon. Keep authenticated (RLS will still
-- limit drivers to their own row + admins to all rows).
-- ============================================================

REVOKE SELECT ON public.eligible_drivers FROM anon;
REVOKE SELECT ON public.driver_churn_risk FROM anon;
