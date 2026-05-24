'use client';

import { useState, useEffect } from 'react';
import { getSupabaseClient } from '@tricigo/api';

interface IsSuperAdminState {
  /** true iff the current admin has role='super_admin'. Default false until loaded. */
  isSuperAdmin: boolean;
  /** Loading state — true while the RPC / query is in-flight. */
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
 * Fallback behavior (frontend tolerance): if the migration hasn't
 * been applied to prod yet, `is_super_admin()` RPC may not exist.
 * The .catch returns false — UX degrades gracefully (Save buttons
 * disabled for everyone), but doesn't crash. Once migration lands,
 * super_admins see Save enabled again.
 *
 * @see supabase/migrations/00291_users_role_super_admin_tier.sql
 * @see supabase/migrations/00292_platform_config_super_admin_tier.sql
 */
export function useIsSuperAdmin(): IsSuperAdminState {
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const supabase = getSupabaseClient();

    // Call the SECURITY DEFINER RPC. Defined in mig 00291.
    // NOTE: supabase.rpc(...) returns a PostgrestBuilder (PromiseLike),
    // which does NOT have a .catch method — only .then. Wrap in an async
    // IIFE so we get proper try/catch semantics and TypeScript stops
    // complaining about Property 'catch' does not exist on PromiseLike.
    (async () => {
      try {
        const { data, error } = await supabase.rpc('is_super_admin');
        if (cancelled) return;
        if (error) {
          // Migration may not be applied yet, or transient error —
          // fall back to false. Save buttons stay disabled until
          // we can confirm super_admin status.
          setIsSuperAdmin(false);
        } else {
          setIsSuperAdmin(Boolean(data));
        }
        setLoading(false);
      } catch {
        if (!cancelled) {
          setIsSuperAdmin(false);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { isSuperAdmin, loading };
}
