'use client';

import React, { useEffect, useState, createContext, useContext } from 'react';
import { initI18n } from '@tricigo/i18n';
import { getSupabaseClient } from '@tricigo/api';
import type { User } from '@supabase/supabase-js';

let i18nInitialized = false;

// ── Auth Context ──
interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  signOut: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

// ── Auth Provider ──
function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Use the shared API client so session is consistent with @tricigo/api services
    const supabase = getSupabaseClient();

    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setIsLoading(false);
    });

    // Listen for auth changes (login, logout, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
        setIsLoading(false);
      },
    );

    return () => subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    const supabase = getSupabaseClient();
    await supabase.auth.signOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, isLoading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

// ── Combined Provider ──
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(i18nInitialized);

  useEffect(() => {
    if (!i18nInitialized) {
      // Restore saved language from localStorage (set in profile/settings)
      const savedLang = typeof window !== 'undefined'
        ? localStorage.getItem('tricigo_language') ?? undefined
        : undefined;
      initI18n(savedLang);
      if (savedLang) {
        document.documentElement.lang = savedLang;
      }
      i18nInitialized = true;
      setReady(true);
    }
  }, []);

  if (!ready) return null;

  return (
    <AuthProvider>
      {children}
    </AuthProvider>
  );
}
