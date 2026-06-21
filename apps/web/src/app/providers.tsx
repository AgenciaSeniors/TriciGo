'use client';

import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { initI18n, i18n } from '@tricigo/i18n';
import { getSupabaseClient, authService } from '@tricigo/api';
import type { User } from '@supabase/supabase-js';

// Initialize i18n synchronously at module load. The resources are bundled JSON
// (no async backend), so the very first render — on the SERVER and on the
// client — has translations ready. This is what lets the whole site be
// server-rendered into the HTML: previously I18nProvider gated every page
// behind a client-only spinner, so crawlers received an empty shell. We default
// to Spanish (matches <html lang="es"> and the canonical content); the user's
// saved language is applied after mount, below.
initI18n();

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
// can never trap a user or loop. When adding a new protected route, add it here.
const APP_ROUTES = ['/book', '/track', '/wallet', '/profile', '/chat', '/rides', '/notifications', '/gift'];

/**
 * Session guard — parity con el guard de apps/client/app/_layout.tsx. If an
 * authenticated user with an incomplete profile lands on an app route (e.g.
 * they closed the tab mid-onboarding), send them to finish: no full_name →
 * /complete-profile, OAuth without phone → /verify-phone.
 *
 * Caches only a COMPLETE profile: while the profile is incomplete we re-check
 * on every navigation, so a user who is redirected and then manually returns to
 * an app route can't slip back in (the móvil guard re-checks on every route).
 * A complete profile can't become incomplete, so caching it is safe and avoids
 * a getUserById on every navigation.
 */
function ProfileGuard({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const completeRef = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading || !isAuthenticated || !user?.id || !pathname) return;
    const onAppRoute = APP_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
    if (!onAppRoute) return;
    if (completeRef.current === user.id) return;
    authService.getUserById(user.id).then((p) => {
      if (!p) return;
      if (!p.full_name) { router.replace('/complete-profile'); return; }
      if (!p.phone) { router.replace('/verify-phone'); return; }
      completeRef.current = user.id;
    }).catch(() => { /* best-effort — never block the app */ });
  }, [isLoading, isAuthenticated, user?.id, pathname, router]);

  return <>{children}</>;
}

// ── Combined Provider ──
export function I18nProvider({ children }: { children: React.ReactNode }) {
  // i18n is already initialized synchronously at module load (see top of file),
  // so children render immediately — including during SSR. After mount, apply
  // the user's saved language (client-only): SSR and the first client render
  // stay on the default 'es', so there is no hydration mismatch; switching to a
  // saved en/pt happens here and triggers a re-render.
  useEffect(() => {
    const savedLang =
      typeof window !== 'undefined'
        ? localStorage.getItem('tricigo_language') ?? undefined
        : undefined;
    if (savedLang && savedLang !== i18n.language) {
      i18n.changeLanguage(savedLang);
      document.documentElement.lang = savedLang;
    }
  }, []);

  return <AuthProvider>{children}</AuthProvider>;
}
