import { useEffect } from 'react';
import { Platform } from 'react-native';
import { configureStorage, createStorageAdapter, authService, customerService } from '@tricigo/api';
import { identifyUser, resetAnalytics, logger } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { useChatStore } from '@/stores/chat.store';
import { useNotificationStore } from '@/stores/notification.store';

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

  useEffect(() => {
    let mounted = true;

    // Safety timeout: if auth init takes >15s, stop loading spinner
    // Use setLoading(false) instead of reset() to avoid clearing a valid session
    const setLoading = useAuthStore.getState().setLoading;
    const safetyTimeout = setTimeout(() => {
      if (mounted && useAuthStore.getState().isLoading) {
        logger.warn('[Auth] Safety timeout: forcing isLoading=false after 15s');
        setLoading(false);
      }
    }, 15000);

    async function init() {
      try {
        const session = await authService.getSession();
        if (session && mounted) {
          const user = await authService.getCurrentUser();
          if (mounted) setUser(user);
          if (user) {
            identifyUser(user.id, { email: user.email });
            customerService.ensureProfile(user.id).catch((err) => logger.warn('[Auth] Failed to ensure profile:', err));
          }
        } else if (mounted) {
          reset();
        }
      } catch (err) {
        // On web, "Lock broken" errors happen during remounts — don't reset auth
        const isLockError = err instanceof Error && err.message?.includes('Lock broken');
        if (isLockError) {
          logger.warn('[Auth] Lock contention during init, retrying...');
          // Retry once after a short delay
          setTimeout(async () => {
            if (!mounted) return;
            try {
              const session = await authService.getSession();
              if (session && mounted) {
                const user = await authService.getCurrentUser();
                if (mounted) setUser(user);
              } else if (mounted) {
                reset();
              }
            } catch {
              if (mounted) reset();
            }
          }, 500);
          return;
        }
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
          useRideStore.getState().resetAll();
          useChatStore.getState().reset();
          useNotificationStore.getState().reset();
        } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          try {
            const user = await authService.getCurrentUser();
            if (mounted) setUser(user);
            if (user) identifyUser(user.id, { email: user.email });
          } catch {
            reset();
          }
        }
      },
    );

    return () => {
      mounted = false;
      clearTimeout(safetyTimeout);
      subscription.unsubscribe();
    };
  }, [setUser, reset]);
}
