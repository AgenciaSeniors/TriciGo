import { useEffect } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { configureStorage, createStorageAdapter, authService, driverService, getSupabaseClient, realtimeStatusLogger } from '@tricigo/api';
import { logger } from '@tricigo/utils';
import { identifyUser, resetAnalytics, realEmail } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useChatStore } from '@/stores/chat.store';
import { useDriverRideStore } from '@/stores/ride.store';
import type { User } from '@tricigo/types';

// ── Offline auth cache ──
// The Supabase session lives in SecureStore and survives offline, but the
// in-memory auth store does not. When the profile/user fetch fails on a
// network blip we must NOT sign the driver out — instead we rehydrate the UI
// from this last-known snapshot so they stay inside the app (their profile /
// home) with an offline banner, exactly like Uber/Bolt. See loadUserAndProfile
// below: a thrown user fetch is treated as transient, never as a sign-out.
const USER_CACHE_KEY = 'tricigo_driver_user_cache_v1';
const PROFILE_CACHE_KEY = 'tricigo_driver_profile_cache_v1';

async function cacheAuthSnapshot(user: User | null, profile: unknown | null): Promise<void> {
  try {
    if (user) await AsyncStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
    if (profile) await AsyncStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
  } catch {
    /* best effort — cache is an optimization, never a hard dependency */
  }
}

async function clearAuthCache(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([USER_CACHE_KEY, PROFILE_CACHE_KEY]);
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

async function readCachedProfile(): Promise<unknown | null> {
  try {
    const raw = await AsyncStorage.getItem(PROFILE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
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

/**
 * Load the driver profile resiliently and update the store — the PROFILE layer.
 *
 * A FAILED fetch (network/timeout/token race) must NOT be mistaken for
 * "no profile", otherwise an already-approved driver gets bounced into the
 * registration form. `getProfileResilient` retries transient errors and
 * returns a discriminated result:
 *   - ok + non-null → set the profile (home) and cache the fresh snapshot.
 *   - ok + null → a genuine missing row → route the new applicant to onboarding
 *     immediately (setProfile(null) sets isProfileLoaded), and cache the user
 *     without a profile so a later offline cold start knows a profile is pending.
 *   - !ok (transient survived all retries) → prefer the cached profile so an
 *     approved driver keeps their home offline; if there is no cache, flag the
 *     error so `_layout` holds the spinner and retries — NEVER onboarding.
 */
async function applyDriverProfile(
  user: User,
  setProfile: (profile: any) => void,
  setProfileError: () => void,
  mounted: { current: boolean },
) {
  const result = await driverService.getProfileResilient(user.id);
  if (!mounted.current) return;
  if (result.ok) {
    setProfile(result.profile);
    // Persist the fresh snapshot for offline cold starts. When the profile is
    // null (row absent) only the user is cached — hydrateFromCacheOrReset treats
    // "user cached, no profile cached" as an UNCONFIRMED profile (spinner+retry),
    // never as "onboarding", so an approved-but-not-yet-cached driver is safe.
    cacheAuthSnapshot(user, result.profile);
  } else {
    const cachedProfile = await readCachedProfile();
    if (!mounted.current) return;
    if (cachedProfile) setProfile(cachedProfile);
    else setProfileError();
  }
}

/**
 * Rehydrate the session UI from the offline cache, or reset() only when there
 * is genuinely nothing to show — the USER layer. Called from the transient-error
 * paths so a network blip keeps the driver inside the app instead of bouncing to
 * login.
 */
async function hydrateFromCacheOrReset(
  setUser: (user: any) => void,
  setProfile: (profile: any) => void,
  setProfileError: () => void,
  reset: () => void,
  mounted: { current: boolean },
) {
  if (!mounted.current) return;

  // Already showing a signed-in user → a prior load already resolved the profile
  // (home) or set the error-spinner+retry state. Do NOT touch the profile gate:
  // forcing setProfileLoaded() here would clear an in-progress profileLoadError
  // and bounce an approved driver to onboarding on a flaky reconnect. Just stay.
  const existingUser = useAuthStore.getState().user;
  if (existingUser) {
    return;
  }

  // Cold start with no in-memory user (e.g. app launched offline): rebuild the
  // session from the last cached snapshot so the profile/home stays available.
  const cachedUser = await readCachedUser();
  if (mounted.current && cachedUser) {
    setUser(cachedUser);
    identifyUser(cachedUser.id, { email: realEmail(cachedUser.email) ?? undefined, role: 'driver' });
    const cachedProfile = await readCachedProfile();
    if (mounted.current) {
      if (cachedProfile) {
        setProfile(cachedProfile);
      } else {
        // Offline with no cached profile: we CANNOT distinguish "new applicant"
        // from "approved but never cached" (the profile cache is only written on
        // a successful online fetch; realtime approval updates do not write it).
        // #801's rule is to never show onboarding on an unconfirmed profile, so
        // flag the error → _layout shows the spinner and retries
        // getProfileResilient every 4s, resolving to home or onboarding the
        // moment connectivity returns. setUser above set authUserId so the retry
        // gate fires.
        setProfileError();
      }
    }
    return;
  }

  // No session in memory and nothing cached → nothing to render. Surface login.
  if (mounted.current) reset();
}

/** Helper: load user + driver profile and update stores */
async function loadUserAndProfile(
  setUser: (user: any) => void,
  setProfile: (profile: any) => void,
  setProfileError: () => void,
  reset: () => void,
  mounted: { current: boolean },
  userId?: string,
) {
  try {
    // Use getUserById when userId is known (avoids extra auth.getUser() HTTP call).
    // Time-box the fetch so a hung request on a flaky network fails fast into the
    // cache-hydration path below instead of stalling the loading gate.
    //
    // NOTE (load-bearing invariant): every call site passes session.user?.id, so
    // getUserById is used — it THROWS on offline / 401 (→ caught → cache hydrate),
    // it never resolves to null. getCurrentUser() CAN return null offline (it
    // ignores getUser()'s error), which would hit the reset() branch below; do
    // not drop the userId arg at a call site without revisiting that branch.
    const user = userId
      ? await withTimeout(authService.getUserById(userId), 8000, 'getUserById')
      : await withTimeout(authService.getCurrentUser(), 8000, 'getCurrentUser');
    if (!mounted.current) return;
    if (user) {
      setUser(user);
      identifyUser(user.id, { email: realEmail(user.email) ?? undefined, role: 'driver' });
      await applyDriverProfile(user, setProfile, setProfileError, mounted);
    } else {
      // getCurrentUser() returned null → the server says there is no user for
      // this session (a genuine invalidation, NOT offline — offline throws and
      // is handled below). Release the loading gate and surface login.
      if (mounted.current) reset();
    }
  } catch {
    // The user fetch threw. loadUserAndProfile is only ever invoked with a
    // valid session (from getSession or an auth event), so a throw here is
    // almost always a transient/network error — NOT a real sign-out. Never kick
    // the driver to login on a network blip; a genuine invalidation arrives as
    // a separate SIGNED_OUT event, which is handled elsewhere.
    await hydrateFromCacheOrReset(setUser, setProfile, setProfileError, reset, mounted);
  }
}

export function useAuthInit() {
  const setUser = useAuthStore((s) => s.setUser);
  const reset = useAuthStore((s) => s.reset);
  const setProfile = useDriverStore((s) => s.setProfile);
  const setProfileError = useDriverStore((s) => s.setProfileError);
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
          // Only wipe the offline cache on an EXPLICIT sign-out. A transient
          // null session must not erase the snapshot we rely on to stay logged
          // in offline.
          if (event === 'SIGNED_OUT') clearAuthCache();
        } else if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          // IMPORTANT: Defer SDK calls to avoid deadlock.
          // _notifyAllSubscribers awaits this callback. If we call
          // supabase.from(...) here, it awaits initializePromise which
          // waits for _notifyAllSubscribers → circular deadlock.
          setTimeout(() => {
            if (!mounted.current) return;
            loadUserAndProfile(setUser, setProfile, setProfileError, reset, mounted, (session as any)?.user?.id);
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
                identifyUser(user.id, { email: realEmail(user.email) ?? undefined, role: 'driver' });
                // Load driver profile in parallel (non-blocking for initial render)
                await applyDriverProfile(user, setProfile, setProfileError, mounted);
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
          await loadUserAndProfile(setUser, setProfile, setProfileError, reset, mounted, session.user?.id);
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
                    identifyUser(user.id, { email: realEmail(user.email) ?? undefined, role: 'driver' });
                    await applyDriverProfile(user, setProfile, setProfileError, mounted);
                    return;
                  }
                }
              }
            } catch { /* exhausted all options */ }
          }
        }
        // getSession() threw (timeout / lock broken) — a transient failure, not
        // proof the session is gone. Keep the driver in the app via the cache
        // instead of ejecting to login.
        await hydrateFromCacheOrReset(setUser, setProfile, setProfileError, reset, mounted);
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
                identifyUser(user.id, { email: realEmail(user.email) ?? undefined, role: 'driver' });
                await applyDriverProfile(user, setProfile, setProfileError, mounted);
                return;
              }
            }
          }
        } catch {
          // direct REST fallback failed
        }
      }

      if (mounted.current) {
        console.warn('[Auth] Safety timeout: exiting loading state (offline-safe)');
        // Don't hard-reset on native: a 10s stall is usually a bad network, not
        // a lost session. Rehydrate from cache so the driver stays inside the
        // app; only fall back to login when there is truly nothing to show.
        await hydrateFromCacheOrReset(setUser, setProfile, setProfileError, reset, mounted);
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
          .subscribe(realtimeStatusLogger('driver_profile'));
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
  }, [setUser, reset, setProfile, setProfileError, resetDriver]);
}
