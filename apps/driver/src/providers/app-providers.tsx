import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PostHogProvider, usePostHog } from 'posthog-react-native';
import { initI18n } from '@tricigo/i18n';
import { initAnalytics } from '@tricigo/utils';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  initOfflineQueue,
  setOnlineStatus,
  registerAllOfflineMutations,
} from '@tricigo/api';
import { useAuthInit } from '@/hooks/useAuth';
import { useNotificationSetup } from '@/hooks/useNotifications';
import { useAuthStore } from '@/stores/auth.store';
import { OfflineBanner } from '@/components/OfflineBanner';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 30,
      retry: 2,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 1,
    },
  },
});

// Initialize offline queue with AsyncStorage adapter
initOfflineQueue({
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
});
registerAllOfflineMutations();

const POSTHOG_API_KEY = process.env.EXPO_PUBLIC_POSTHOG_API_KEY ?? '';

/** Bridges PostHog SDK ↔ shared analytics abstraction */
function AnalyticsInit() {
  const posthog = usePostHog();
  useEffect(() => {
    if (!posthog) return;
    initAnalytics({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      capture: (event, props) => posthog.capture(event, props as any),
      identify: (userId, traits) => posthog.identify(userId, traits as any),
      reset: () => posthog.reset(),
    });
  }, [posthog]);
  return null;
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  useAuthInit();
  const user = useAuthStore((s) => s.user);
  useNotificationSetup(user?.id);

  useEffect(() => {
    (async () => {
      // Prioritize saved preference, default to Spanish
      const savedLang = await AsyncStorage.getItem('tricigo_language');
      if (savedLang && ['es', 'en', 'pt'].includes(savedLang)) {
        initI18n(savedLang);
        return;
      }
      initI18n('es');
    })();
  }, []);

  // Subscribe to network state changes
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setOnlineStatus(state.isConnected ?? true);
    });
    return () => unsubscribe();
  }, []);

  const inner = (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <OfflineBanner />
        {children}
      </QueryClientProvider>
    </SafeAreaProvider>
  );

  if (!POSTHOG_API_KEY) return inner;

  return (
    <PostHogProvider
      apiKey={POSTHOG_API_KEY}
      options={{
        host: 'https://us.i.posthog.com',
        flushAt: 10,
        flushInterval: 30000,
      }}
      autocapture={false}
    >
      <AnalyticsInit />
      {inner}
    </PostHogProvider>
  );
}
