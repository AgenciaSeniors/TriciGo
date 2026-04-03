import { useEffect } from 'react';
import { Platform } from 'react-native';
import { configureStorage, createStorageAdapter, authService, driverService, getSupabaseClient } from '@tricigo/api';
import { identifyUser, resetAnalytics } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useChatStore } from '@/stores/chat.store';
import { useDriverRideStore } from '@/stores/ride.store';

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

/** Helper: load user + driver profile and update stores */
async function loadUserAndProfile(
  setUser: (user: any) => void,
  setProfile: (profile: any) => void,
  setProfileLoaded: () => void,
  reset: () => void,
  mounted: { current: boolean },
) {
  try {
    const user = await authService.getCurrentUser();
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
      async (event, session) => {
        if (!mounted.current) return;

        // Handle INITIAL_SESSION with a valid session (e.g., after OAuth redirect)
        if (event === 'INITIAL_SESSION' && session) {
          await loadUserAndProfile(setUser, setProfile, setProfileLoaded, reset, mounted);
          return;
        }

        if (event === 'SIGNED_OUT' || !session) {
          resetAnalytics();
          reset();
          resetDriver();
          useChatStore.getState().reset();
          useDriverRideStore.getState().reset();
        } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          await loadUserAndProfile(setUser, setProfile, setProfileLoaded, reset, mounted);
        }
      },
    );

    // ── STEP 2: Check existing session ──
    async function init() {
      try {
        const session = await authService.getSession();
        if (session && mounted.current) {
          await loadUserAndProfile(setUser, setProfile, setProfileLoaded, reset, mounted);
        } else if (mounted.current) {
          reset();
        }
      } catch (err) {
        const isLockError = err instanceof Error && err.message?.includes('Lock broken');
        if (isLockError) {
          console.warn('[Auth] Lock contention during init, retrying...');
          setTimeout(async () => {
            if (!mounted.current) return;
            try {
              const session = await authService.getSession();
              if (session && mounted.current) {
                await loadUserAndProfile(setUser, setProfile, setProfileLoaded, reset, mounted);
              } else if (mounted.current) {
                reset();
              }
            } catch {
              if (mounted.current) reset();
            }
          }, 500);
          return;
        }
        if (mounted.current) reset();
      }
    }

    init();

    // ── STEP 3: Safety timeout ──
    // If isLoading is still true after 8 seconds, force exit loading state.
    // This prevents infinite spinner in any edge case.
    const safetyTimeout = setTimeout(() => {
      if (!mounted.current) return;
      const state = useAuthStore.getState();
      if (state.isLoading) {
        console.warn('[Auth] Safety timeout: forcing exit from loading state');
        reset();
      }
    }, 8000);

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
