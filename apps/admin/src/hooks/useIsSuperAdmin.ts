'use client';

import { usePanelRole } from '@/lib/panelRole';

interface IsSuperAdminState {
  /** true iff the current admin has role='super_admin'. Default false until loaded. */
  isSuperAdmin: boolean;
  /** Loading state — true while the role is not known yet. */
  loading: boolean;
}

/**
 * Hook that resolves whether the current admin user has
 * `role='super_admin'`. Used to gate UI for security-critical
 * actions (commission_rate change, feature_flag toggle for KYC /
 * RATE_LIMIT, role promotion, etc) that require super_admin tier
 * per ADM-002.
 *
 * Server-side enforcement lives in the RLS policies and the
 * `tg_users_protect_admin_fields` trigger (mig 00291 / 00292) —
 * this hook only handles the UX layer so non-super-admins see
 * disabled controls instead of toast-after-failed-save.
 *
 * It reads the role the panel already has (PanelRoleProvider, from the
 * middleware's cookie). It used to call the is_super_admin RPC on every
 * mount of the seven pages that use it (2026-10-12).
 *
 * @see supabase/migrations/00291_users_role_super_admin_tier.sql
 * @see supabase/migrations/00292_platform_config_super_admin_tier.sql
 */
export function useIsSuperAdmin(): IsSuperAdminState {
  const { role, loading } = usePanelRole();
  return { isSuperAdmin: role === 'super_admin', loading };
}
