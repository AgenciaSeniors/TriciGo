'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { createBrowserClient } from './supabase-server';

interface AdminUser {
  user: SupabaseUser | null;
  userId: string;
  email: string;
  loading: boolean;
}

const LOADING: AdminUser = { user: null, userId: '', email: '', loading: true };

const AdminUserContext = createContext<AdminUser>(LOADING);

function toAdminUser(user: SupabaseUser | null): AdminUser {
  return {
    user,
    userId: user?.id ?? '',
    email: user?.email ?? user?.phone ?? 'Admin',
    loading: false,
  };
}

/**
 * Reads the signed-in user once for the whole panel (AdminShell mounts it).
 *
 * getSession() reads the session from the cookies: no network call unless the
 * token has to be refreshed. The middleware already verified it on the server
 * for this request, and the database checks every call again (RLS, RPC gates).
 * Until 2026-10 each of the ~15 components using useAdminUser called getUser(),
 * a network call, and then copied the session into @tricigo/api's client with
 * setSession(), another one. Now @tricigo/api uses this same client
 * (sharedClient.ts), so there is nothing to copy.
 */
export function AdminUserProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AdminUser>(LOADING);

  useEffect(() => {
    const supabase = createBrowserClient();
    let cancelled = false;
    // A token refresh hands over the same user: keep the same object so the
    // pages' effects that depend on it do not run again.
    const apply = (user: SupabaseUser | null) => {
      if (cancelled) return;
      const next = toAdminUser(user);
      setState((prev) =>
        !prev.loading && prev.userId === next.userId && prev.email === next.email ? prev : next,
      );
    };

    supabase.auth
      .getSession()
      .then(({ data }) => apply(data.session?.user ?? null))
      .catch(() => apply(null));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => apply(session?.user ?? null));

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  return <AdminUserContext.Provider value={state}>{children}</AdminUserContext.Provider>;
}

/** The signed-in user. `loading` is true until AdminUserProvider has read the session. */
export function useAdminUser(): AdminUser {
  return useContext(AdminUserContext);
}
