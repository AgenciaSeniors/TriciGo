import { useEffect } from 'react';
import { Platform } from 'react-native';
import { configureStorage, createStorageAdapter, authService, driverService, getSupabaseClient } from '@tricigo/api';
import { logger } from '@tricigo/utils';
import { identifyUser, resetAnalytics } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useChatStore } from '@/stores/chat.store';
import { useDriverRideStore } from '@/stores/ride.store';
import type { User } from '@tricigo/types';

// Use SecureStore on native, localStorage on web
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const localStorage: any;

const storageOps =
  Platform.OS === 'web'
    ? {
        get: (key: string) => Promise.resolve(localStorage.getItem(key)),
        set: (key: string, value: string) => {
          localStorage.setItem(key, value);
          return Promise.resolve();
        },
        remove: (key: string) => {
          localStorage.removeItem(key);
          return Promise.resolve();
        },
      }
    : (() => {
        const SecureStore = require('expo-secure-store');
        return {
          get: (key: string) => SecureStore.getItemAsync(key),
          set: (key: string, value: string) => SecureStore.setItemAsync(key, value),
          remove: (key: string) => SecureStore.deleteItemAsync(key),
        };
      })();

const adapter = createStorageAdapter(storageOps);
configureStorage(adapter);

/** Wrap a promise with a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * On web, fetch the user profile directly via REST API, bypassing the
 * Supabase JS SDK which can hang due to internal lock contention.
 */
async function fetchUserDirectWeb(userId: string, accessToken: string, anonKey: string): Promise<User | null> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return null;

  const res = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=*`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'apikey': anonKey,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows?.[0] ?? null;
}

/** Helper: load user + driver profile and update stores */
async function loadUserAndProfile(
  setUser: (user: any) => void,
  setProfile: (profile: any) => void,
  setProfileLoaded: () => void,
  reset: () => void,
  mounted: { current: boolean },
  userId?: string,
) {
  try {
    // Use getUserById when userId is known (avoids extra auth.getUser() HTTP call)
    const user = userId
      ? await authService.getUserById(userId)
      : await authService.getCurrentUser();
    if (!mounted.current) return;
    setUser(user);
    if (user) {
      identifyUser(user.id, { email: user.email, role: 'driver' });
      try {
        const dp = await driverService.getProfile(user.id);
        if (mounted.current) setProfile(dp);
      } catch {
        // No driver profile yet — user needs onboarding
        // Still mark profile as loaded so routing can proceed
        if (mounted.current) setProfileLoaded();
      }
    } else {
      // No user — mark profile loaded to unblock routing
      if (mounted.current) setProfileLoaded();
    }
  } catch {
    if (mounted.current) reset();
  }
}

export function useAuthInit() {
  const setUser = useAuthStore((s) => s.setUser);
  const reset = useAuthStore((s) => s.reset);
  const setProfile = useDriverStore((s) => s.setProfile);
  const setProfileLoaded = useDriverStore((s) => s.setProfileLoaded);
  const resetDriver = useDriverStore((s) => s.reset);

  useEffect(() => {
    const mounted = { current: true };

    // ── STEP 1: Register auth state listener FIRST ──
    // This MUST happen before getSession() so we catch the SIGNED_IN event
    // that Supabase fires when it detects OAuth tokens in the URL hash.
    const { data: { subscription } } = authService.onAuthStateChange(
      (event, session) => {
        if (!mounted.current) return;

        if (event === 'SIGNED_OUT' || !session) {
          resetAnalytics();
          reset();
          resetDriver();
          useChatStore.getState().reset();
          useDriverRideStore.getState().reset();
        } else if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          // IMPORTANT: Defer SDK calls to avoid deadlock.
          // _notifyAllSubscribers awaits this callback. If we call
          // supabase.from(...) here, it awaits initializePromise which
          // waits for _notifyAllSubscribers → circular deadlock.
          setTimeout(() => {
            if (!mounted.current) return;
            loadUserAndProfile(setUser, setProfile, setProfileLoaded, reset, mounted, (session as any)?.user?.id);
          }, 0);
        }
      },
    );

    // ── STEP 2: Check existing session ──
    async function init() {
      // ── WEB FAST PATH ──
      // On web, the Supabase JS SDK's getSession() frequently hangs due to
      // internal lock contention with navigator.locks. Bypass it entirely:
      // read the session from localStorage, then fetch the user via REST.
      if (Platform.OS === 'web') {
        try {
          const raw = localStorage.getItem('sb-tricigo-auth');
          if (raw) {
            const parsed = JSON.parse(raw);
            const expiresAt = parsed.expires_at ?? 0;
            const now = Math.floor(Date.now() / 1000);

            if (expiresAt > now && parsed.user?.id && parsed.access_token) {
              const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
              const user = await withTimeout(
                fetchUserDirectWeb(parsed.user.id, parsed.access_token, anonKey),
                5000,
                'fetchUserDirectWeb',
              );
              if (mounted.current && user) {
                logger.info('[Auth] Web fast-path: session restored from localStorage');
                setUser(user);
                identifyUser(user.id, { email: user.email, role: 'driver' });
                // Load driver profile in parallel (non-blocking for initial render)
                try {
                  const dp = await driverService.getProfile(user.id);
                  if (mounted.current) setProfile(dp);
                } catch {
                  if (mounted.current) setProfileLoaded();
                }
                return;
              }
            }
          }
        } catch (err) {
          logger.warn('[Auth] Web fast-path failed, falling back to SDK:', { error: String(err) });
        }
      }

      // ── STANDARD PATH (native + web fallback) ──
      try {
        const session = await withTimeout(authService.getSession(), 8000, 'getSession');
        if (session && mounted.current) {
          await loadUserAndProfile(setUser, setProfile, setProfileLoaded, reset, mounted, session.user?.id);
        } else if (mounted.current) {
          reset();
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('Lock broken') || errMsg.includes('timed out')) {
          logger.warn(`[Auth] SDK init failed (${errMsg}), trying direct fetch...`);
          // Last resort on web: direct REST fetch
          if (Platform.OS === 'web') {
            try {
              const raw = localStorage.getItem('sb-tricigo-auth');
              if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed.user?.id && parsed.access_token) {
                  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
                  const user = await withTimeout(
                    fetchUserDirectWeb(parsed.user.id, parsed.access_token, anonKey),
                    5000,
                    'fetchUserDirectWeb-fallback',
                  );
                  if (mounted.current && user) {
                    setUser(user);
                    identifyUser(user.id, { email: user.email, role: 'driver' });
                    try {
                      const dp = await driverService.getProfile(user.id);
                      if (mounted.current) setProfile(dp);
                    } catch {
                      if (mounted.current) setProfileLoaded();
                    }
                    return;
                  }
                }
              }
            } catch { /* exhausted all options */ }
          }
        }
        if (mounted.current) reset();
      }
    }

    init();

    // ── STEP 3: Safety timeout ──
    // If isLoading is still true after 10 seconds, try direct REST fallback
    // before giving up. This prevents redirecting to login when session is valid.
    const safetyTimeout = setTimeout(async () => {
      if (!mounted.current) return;
      const state = useAuthStore.getState();
      if (!state.isLoading) return;

      console.warn('[Auth] Safety timeout after 10s — attempting direct REST fallback');

      if (Platform.OS === 'web') {
        try {
          const raw = localStorage.getItem('sb-tricigo-auth');
          if (raw) {
            const parsed = JSON.parse(raw);
            const expiresAt = parsed.expires_at ?? 0;
            const now = Math.floor(Date.now() / 1000);
            if (expiresAt > now && parsed.user?.id && parsed.access_token) {
              const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
              const user = await withTimeout(
                fetchUserDirectWeb(parsed.user.id, parsed.access_token, anonKey),
                5000,
                'fetchUserDirectWeb-safety',
              );
              if (mounted.current && user) {
                console.warn('[Auth] Safety timeout: restored session via direct REST');
                setUser(user);
                identifyUser(user.id, { email: user.email, role: 'driver' });
                try {
                  const dp = await driverService.getProfile(user.id);
                  if (mounted.current) setProfile(dp);
                } catch {
                  if (mounted.current) setProfileLoaded();
                }
                return;
              }
            }
          }
        } catch {
          // direct REST fallback failed
        }
      }

      if (mounted.current) {
        console.warn('[Auth] Safety timeout: forcing exit from loading state');
        reset();
      }
    }, 10000);

    // ── STEP 4: Subscribe to driver profile changes in realtime ──
    let profileChannel: ReturnType<ReturnType<typeof getSupabaseClient>['channel']> | null = null;
    async function subscribeToProfile() {
      try {
        const session = await authService.getSession();
        if (!session?.user || !mounted.current) return;
        const supabase = getSupabaseClient();
        profileChannel = supabase
          .channel(`driver-profile-${session.user.id}`)
          .on(
            'postgres_changes',
            {
              event: 'UPDATE',
              schema: 'public',
              table: 'driver_profiles',
              filter: `user_id=eq.${session.user.id}`,
            },
            (payload) => {
              if (mounted.current && payload.new) {
                setProfile(payload.new as any);
              }
            },
          )
          .subscribe();
      } catch {
        // Best effort — profile sync is non-critical
      }
    }
    subscribeToProfile();

    return () => {
      mounted.current = false;
      clearTimeout(safetyTimeout);
      subscription.unsubscribe();
      if (profileChannel) {
        getSupabaseClient().removeChannel(profileChannel);
      }
    };
  }, [setUser, reset, setProfile, setProfileLoaded, resetDriver]);
}
