import { useEffect } from 'react';
import { Platform } from 'react-native';
import { configureStorage, createStorageAdapter, authService, driverService } from '@tricigo/api';
import { identifyUser, resetAnalytics } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';

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

export function useAuthInit() {
  const setUser = useAuthStore((s) => s.setUser);
  const reset = useAuthStore((s) => s.reset);
  const setProfile = useDriverStore((s) => s.setProfile);
  const resetDriver = useDriverStore((s) => s.reset);

  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        const session = await authService.getSession();
        if (session && mounted) {
          const user = await authService.getCurrentUser();
          if (mounted) setUser(user);
          if (user) {
            identifyUser(user.id, { email: user.email, role: 'driver' });
            try {
              const dp = await driverService.getProfile(user.id);
              if (mounted) setProfile(dp);
            } catch {
              // No driver profile yet - user needs onboarding
            }
          }
        } else if (mounted) {
          reset();
        }
      } catch {
        if (mounted) reset();
      }
    }

    init();

    const { data: { subscription } } = authService.onAuthStateChange(
      async (event, session) => {
        if (!mounted) return;
        if (event === 'SIGNED_OUT' || !session) {
          resetAnalytics();
          reset();
          resetDriver();
        } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          try {
            const user = await authService.getCurrentUser();
            if (mounted) setUser(user);
            if (user) {
              identifyUser(user.id, { email: user.email, role: 'driver' });
              try {
                const dp = await driverService.getProfile(user.id);
                if (mounted) setProfile(dp);
              } catch {
                // No driver profile - needs onboarding
              }
            }
          } catch {
            reset();
          }
        }
      },
    );

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [setUser, reset, setProfile, resetDriver]);
}
