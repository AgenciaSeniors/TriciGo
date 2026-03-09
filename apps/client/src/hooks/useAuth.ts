import { useEffect } from 'react';
import * as SecureStore from 'expo-secure-store';
import { configureStorage, createStorageAdapter, authService, customerService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';

const adapter = createStorageAdapter({
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
});
configureStorage(adapter);

export function useAuthInit() {
  const setUser = useAuthStore((s) => s.setUser);
  const reset = useAuthStore((s) => s.reset);

  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        const session = await authService.getSession();
        if (session && mounted) {
          const user = await authService.getCurrentUser();
          if (mounted) setUser(user);
          if (user) {
            customerService.ensureProfile(user.id).catch(() => {});
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
        } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          try {
            const user = await authService.getCurrentUser();
            if (mounted) setUser(user);
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
  }, [setUser, reset]);
}
