import { useEffect } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { configureStorage, createStorageAdapter, authService, customerService } from '@tricigo/api';
import { identifyUser, resetAnalytics, logger, realEmail } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { useChatStore } from '@/stores/chat.store';
import { useNotificationStore } from '@/stores/notification.store';
import type { User } from '@tricigo/types';

// ── Offline auth cache ──
// The Supabase session survives offline in SecureStore, but the in-memory auth
// store does not. When the user fetch fails on a network blip we must NOT sign
// the passenger out — we rehydrate from this last-known snapshot so they stay
// inside the app instead of bouncing to login. When the network returns the
// normal fetch refreshes it.
const USER_CACHE_KEY = 'tricigo_client_user_cache_v1';

async function cacheUser(user: User | null): Promise<void> {
  try {
    if (user) await AsyncStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
  } catch {
    /* best effort — cache is an optimization, never a hard dependency */
  }
}

async function clearAuthCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(USER_CACHE_KEY);
  } catch {
    /* best effort */
  }
}

async function readCachedUser(): Promise<User | null> {
  try {
    const raw = await AsyncStorage.getItem(USER_CACHE_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

/**
 * Rehydrate the session UI from the offline cache, or reset() only when there
 * is genuinely nothing to show. Keeps the passenger in the app on a network
 * blip instead of ejecting to login.
 */
async function hydrateFromCacheOrReset(
  setUser: (user: User | null) => void,
  reset: () => void,
  isMounted: () => boolean,
): Promise<void> {
  if (!isMounted()) return;
  // Already showing a signed-in user → stay put.
  if (useAuthStore.getState().user) return;
  const cached = await readCachedUser();
  if (isMounted() && cached) {
    setUser(cached);
    identifyUser(cached.id, { email: realEmail(cached.email) ?? undefined });
    customerService.ensureProfile(cached.id).catch(() => { /* offline — best effort */ });
    return;
  }
  if (isMounted()) reset();
}

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

export function useAuthInit() {
  const setUser = useAuthStore((s) => s.setUser);
  const reset = useAuthStore((s) => s.reset);

  useEffect(() => {
    let mounted = true;

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
              if (mounted && user) {
                logger.info('[Auth] Web fast-path: session restored from localStorage');
                setUser(user);
                identifyUser(user.id, { email: realEmail(user.email) ?? undefined });
                customerService.ensureProfile(user.id).catch((err) =>
                  logger.warn('[Auth] Failed to ensure profile:', { error: String(err) }),
                );
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
        if (session && mounted) {
          const userId = session.user?.id;
          const user = userId
            ? await withTimeout(authService.getUserById(userId), 8000, 'getUserById')
            : await withTimeout(authService.getCurrentUser(), 8000, 'getCurrentUser');
          if (mounted) setUser(user);
          if (user) {
            identifyUser(user.id, { email: realEmail(user.email) ?? undefined });
            cacheUser(user);
            customerService.ensureProfile(user.id).catch((err) =>
              logger.warn('[Auth] Failed to ensure profile:', { error: String(err) }),
            );
          }
        } else if (mounted) {
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
                  if (mounted && user) {
                    setUser(user);
                    cacheUser(user);
                    return;
                  }
                }
              }
            } catch { /* exhausted all options */ }
          }
        }
        // The user fetch threw (network / timeout / lock) — not proof the
        // session is gone. Keep the passenger in the app via the cache instead
        // of ejecting to login; the next online fetch refreshes it.
        await hydrateFromCacheOrReset(setUser, reset, () => mounted);
      }
    }

    init();

    // ── AUTH STATE LISTENER ──
    // Still register the Supabase listener for sign-in/sign-out events.
    // This handles OAuth redirects, token refresh, and sign-out.
    const { data: { subscription } } = authService.onAuthStateChange(
      (event, session) => {
        if (!mounted) return;
        if (event === 'SIGNED_OUT' || !session) {
          resetAnalytics();
          reset();
          useRideStore.getState().resetAll();
          useChatStore.getState().reset();
          useNotificationStore.getState().reset();
          // Only wipe the offline cache on an EXPLICIT sign-out. A transient
          // null session must not erase the snapshot we rely on to stay logged
          // in offline.
          if (event === 'SIGNED_OUT') clearAuthCache();
        } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          // IMPORTANT: Defer SDK calls to avoid deadlock.
          // _notifyAllSubscribers awaits this callback. If we call
          // supabase.from(...) here, it awaits initializePromise which
          // waits for _notifyAllSubscribers → circular deadlock.
          setTimeout(async () => {
            if (!mounted) return;
            try {
              const userId = (session as any).user?.id;
              const user = userId
                ? await authService.getUserById(userId)
                : await authService.getCurrentUser();
              if (mounted) setUser(user);
              if (user) {
                identifyUser(user.id, { email: realEmail(user.email) ?? undefined });
                cacheUser(user);
              }
            } catch {
              // Network/transient failure — never eject on a blip. Keep the
              // passenger in the app via the cache (a real invalidation arrives
              // as a separate SIGNED_OUT event).
              await hydrateFromCacheOrReset(setUser, reset, () => mounted);
            }
          }, 0);
        }
      },
    );

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [setUser, reset]);
}
