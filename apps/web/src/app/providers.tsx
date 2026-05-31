'use client';

import React, { useEffect, useState, useRef, createContext, useContext } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { initI18n } from '@tricigo/i18n';
import { getSupabaseClient, authService } from '@tricigo/api';
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
      <ProfileGuard>{children}</ProfileGuard>
    </AuthContext.Provider>
  );
}

// App routes that require a complete profile (full_name + phone). Marketing,
// legal, auth and onboarding routes are intentionally NOT here so the guard
// can never trap a user or loop.
const APP_ROUTES = ['/book', '/track', '/wallet', '/profile', '/chat', '/rides', '/notifications', '/gift'];

/**
 * Session guard — parity con el guard de apps/client/app/_layout.tsx. If an
 * authenticated user with an incomplete profile lands on an app route (e.g.
 * they closed the tab mid-onboarding), send them to finish: no full_name →
 * /complete-profile, OAuth without phone → /verify-phone. Checks once per user.
 */
function ProfileGuard({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const checkedRef = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading || !isAuthenticated || !user?.id || !pathname) return;
    const onAppRoute = APP_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
    if (!onAppRoute) return;
    if (checkedRef.current === user.id) return;
    checkedRef.current = user.id;
    authService.getUserById(user.id).then((p) => {
      if (!p) return;
      if (!p.full_name) router.replace('/complete-profile');
      else if (!p.phone) router.replace('/verify-phone');
    }).catch(() => { /* best-effort — never block the app */ });
  }, [isLoading, isAuthenticated, user?.id, pathname, router]);

  return <>{children}</>;
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

  if (!ready) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
      }}>
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary, #999)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: 'var(--primary, #00C853)' }}>Go</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AuthProvider>
      {children}
    </AuthProvider>
  );
}
