-- ============================================================
-- ADM-002 (security audit 2026-05-23, Admin escalation kill chain):
-- The following tables have `_admin: FOR ALL USING is_admin()`
-- policies — meaning ANY admin (admin OR super_admin) can write:
--
--   * platform_config — commission_rate, exchange_rate_fallback,
--                       and any global tuning knob
--   * feature_flags   — KYC_ENABLED, RATE_LIMIT_ENABLED,
--                       FRAUD_DETECTION_ENABLED, SELFIE_VERIFICATION_ENABLED
--   * pricing_rules   — base_fare, per_km_rate, surge predictions
--                       per zone/time
--   * service_type_configs — base fares and rates per vehicle type
--
-- A regular admin (or admin account compromised via phishing) can:
--
--   UPDATE platform_config SET value = '0' WHERE key = 'commission_rate';
--     → platform stops earning commission silently. No UI alert.
--
--   UPDATE feature_flags SET enabled = false WHERE key = 'KYC_ENABLED';
--     → new drivers onboard without identity verification.
--
--   UPDATE pricing_rules SET surge_multiplier = 0.1 WHERE id = ...;
--     → all rides in that zone/time charge near-zero.
--
-- The damage is silent (no UI showing "commission disabled banner")
-- and detection requires comparing revenue real vs expected over
-- days/weeks.
--
-- (`exchange_rates` is already deny-by-default for write — only a
-- SELECT policy exists. No change needed there. Future change to
-- that table should follow this same super_admin tier pattern.)
--
-- Fix: split each `_admin` policy into:
--   * `_super_admin_write` for INSERT/UPDATE/DELETE — gated on
--     is_super_admin() (mig 00291).
--   * `_admin_read` for SELECT — gated on is_admin() for tables
--     that aren't already publicly readable.
--
-- The existing `_select` policies (which read `USING true` or
-- `is_active`) are intentionally preserved — they let the client
-- apps read commission_rate, surge zones, service configs, and
-- feature flags as needed for UX (commission preview at checkout,
-- vehicle types in booking, surge banner). Read access is fine;
-- write access is what we're locking down.
--
-- Companion: PR-02 frontend (apps/admin/src/hooks/useIsSuperAdmin.ts
-- + settings pages) disables save buttons for non-super-admins so
-- the UI doesn't even try the UPDATE that would now fail. Failed
-- UPDATE shows a toast "Requires super_admin role" — graceful
-- degradation if a stale page tries anyway.
-- ============================================================

-- ── platform_config ──
DROP POLICY IF EXISTS pc_admin ON public.platform_config;

CREATE POLICY pc_super_admin_insert ON public.platform_config
  FOR INSERT WITH CHECK (public.is_super_admin());

CREATE POLICY pc_super_admin_update ON public.platform_config
  FOR UPDATE USING (public.is_super_admin())
              WITH CHECK (public.is_super_admin());

CREATE POLICY pc_super_admin_delete ON public.platform_config
  FOR DELETE USING (public.is_super_admin());

-- pc_select (USING true) preserved — clients need to read commission_rate
-- and other settings for UX.

-- ── feature_flags ──
DROP POLICY IF EXISTS ff_admin ON public.feature_flags;

CREATE POLICY ff_super_admin_insert ON public.feature_flags
  FOR INSERT WITH CHECK (public.is_super_admin());

CREATE POLICY ff_super_admin_update ON public.feature_flags
  FOR UPDATE USING (public.is_super_admin())
              WITH CHECK (public.is_super_admin());

CREATE POLICY ff_super_admin_delete ON public.feature_flags
  FOR DELETE USING (public.is_super_admin());

-- ff_select (USING true) preserved — clients read flags at runtime.

-- ── pricing_rules ──
DROP POLICY IF EXISTS pr_admin ON public.pricing_rules;

CREATE POLICY pr_super_admin_insert ON public.pricing_rules
  FOR INSERT WITH CHECK (public.is_super_admin());

CREATE POLICY pr_super_admin_update ON public.pricing_rules
  FOR UPDATE USING (public.is_super_admin())
              WITH CHECK (public.is_super_admin());

CREATE POLICY pr_super_admin_delete ON public.pricing_rules
  FOR DELETE USING (public.is_super_admin());

-- pr_select preserved — already gated on (is_active OR is_admin()),
-- which lets regular admins audit inactive rules.

-- ── service_type_configs ──
DROP POLICY IF EXISTS stc_admin ON public.service_type_configs;

CREATE POLICY stc_super_admin_insert ON public.service_type_configs
  FOR INSERT WITH CHECK (public.is_super_admin());

CREATE POLICY stc_super_admin_update ON public.service_type_configs
  FOR UPDATE USING (public.is_super_admin())
              WITH CHECK (public.is_super_admin());

CREATE POLICY stc_super_admin_delete ON public.service_type_configs
  FOR DELETE USING (public.is_super_admin());

-- stc_select (USING true) preserved — clients read base_fare /
-- per_km_rate for fare estimate UX.

COMMENT ON POLICY pc_super_admin_update ON public.platform_config IS
  'ADM-002: commission_rate, exchange_rate_fallback_cup, and other global tuning knobs require super_admin to mutate. Regular admins can still read for monitoring.';
