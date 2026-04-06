import { useEffect } from 'react';
import { Platform } from 'react-native';
import { configureStorage, createStorageAdapter, authService, customerService } from '@tricigo/api';
import { identifyUser, resetAnalytics, logger } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { useChatStore } from '@/stores/chat.store';
import { useNotificationStore } from '@/stores/notification.store';
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
                identifyUser(user.id, { email: user.email });
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
            identifyUser(user.id, { email: user.email });
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
                    return;
                  }
                }
              }
            } catch { /* exhausted all options */ }
          }
        }
        if (mounted) reset();
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
              if (user) identifyUser(user.id, { email: user.email });
            } catch {
              // Don't reset on token refresh failures — session may still be valid
              if (event === 'SIGNED_IN' && mounted) reset();
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
