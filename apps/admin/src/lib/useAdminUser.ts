'use client';

import { useState, useEffect } from 'react';
import { createBrowserClient } from './supabase-server';
import type { User as SupabaseUser } from '@supabase/supabase-js';

interface AdminUser {
  user: SupabaseUser | null;
  userId: string;
  email: string;
  loading: boolean;
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
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
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
