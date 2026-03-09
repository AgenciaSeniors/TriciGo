import { useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';
import { configureStorage, createStorageAdapter, authService, driverService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';

const adapter = createStorageAdapter({
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
});
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
          reset();
          resetDriver();
        } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          try {
            const user = await authService.getCurrentUser();
            if (mounted) setUser(user);
            if (user) {
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
