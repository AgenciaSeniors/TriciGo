'use client';

import { useState, useEffect } from 'react';
import { createBrowserClient } from './supabase-server';
import { getSupabaseClient } from '@tricigo/api';
import type { User as SupabaseUser } from '@supabase/supabase-js';

interface AdminUser {
  user: SupabaseUser | null;
  userId: string;
  email: string;
  loading: boolean;
}

/**
 * Sync SSR cookie session to the shared @tricigo/api client.
 * The admin Next.js app uses @supabase/ssr (cookies), but @tricigo/api
 * uses a localStorage-based client. This bridges the gap so RLS queries
 * carry the correct JWT.
 */
async function syncSessionToSharedClient(ssrClient: ReturnType<typeof createBrowserClient>) {
  try {
    const { data: { session } } = await ssrClient.auth.getSession();
    if (session) {
      const sharedClient = getSupabaseClient();
      await sharedClient.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
    }
  } catch {
    // Best-effort: admin service will fallback to empty results
  }
}

/**
 * Hook to get the currently authenticated admin user.
 * Falls back to empty string for userId if not yet loaded
 * (middleware guarantees admin role, so this is safe).
 */
export function useAdminUser(): AdminUser {
  const [user, setUser] = useState<SupabaseUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createBrowserClient();

    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      // Sync session to shared @tricigo/api client for RLS
      syncSessionToSharedClient(supabase);
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      // Re-sync on auth state change (token refresh, re-login)
      if (session) syncSessionToSharedClient(supabase);
    });

    return () => subscription.unsubscribe();
  }, []);

  return {
    user,
    userId: user?.id ?? '',
    email: user?.email ?? user?.phone ?? 'Admin',
    loading,
  };
}
