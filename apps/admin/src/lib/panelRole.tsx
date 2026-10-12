'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { isPanelRole, panelRoleFromCookies, type PanelRole } from '@tricigo/utils/adminPanelAccess';
import { createBrowserClient } from './supabase-server';

interface PanelRoleState {
  /** admin, super_admin or marketing; null when it could not be read. */
  role: PanelRole | null;
  loading: boolean;
}

const PanelRoleContext = createContext<PanelRoleState>({ role: null, loading: true });

/**
 * The signed-in user's role for the whole panel (00642, marketing role).
 * The middleware already refused anyone without a panel role; this only shapes the UI.
 * The server enforces every permission on its own (RLS, RPC gates, Edge Functions).
 *
 * It comes from the cookie the middleware writes on every page it lets through
 * (PANEL_ROLE_COOKIE), so the panel draws without waiting for a database round trip.
 * Without that cookie (a session opened before it existed) it is read from users.
 */
export function PanelRoleProvider({
  userId,
  initialRole,
  children,
}: {
  userId: string;
  /** Dev design previews run without a session: they render as an admin. */
  initialRole?: PanelRole;
  children: React.ReactNode;
}) {
  const [cookieRole] = useState<PanelRole | null>(() =>
    initialRole || typeof document === 'undefined' ? null : panelRoleFromCookies(document.cookie),
  );
  const [state, setState] = useState<PanelRoleState>(() => {
    const known = initialRole ?? cookieRole;
    return known ? { role: known, loading: false } : { role: null, loading: true };
  });

  useEffect(() => {
    if (initialRole || cookieRole) return;
    if (!userId) {
      setState({ role: null, loading: false });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data } = await createBrowserClient().from('users').select('role').eq('id', userId).single();
        const role: unknown = data?.role;
        if (!cancelled) setState({ role: isPanelRole(role) ? role : null, loading: false });
      } catch {
        if (!cancelled) setState({ role: null, loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, initialRole, cookieRole]);

  return <PanelRoleContext.Provider value={state}>{children}</PanelRoleContext.Provider>;
}

export function usePanelRole(): PanelRoleState {
  return useContext(PanelRoleContext);
}
