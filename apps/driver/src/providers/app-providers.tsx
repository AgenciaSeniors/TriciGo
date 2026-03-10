import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { initI18n } from '@tricigo/i18n';
import * as Localization from 'expo-localization';
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

export function AppProviders({ children }: { children: React.ReactNode }) {
  useAuthInit();
  const user = useAuthStore((s) => s.user);
  useNotificationSetup(user?.id);

  useEffect(() => {
    const locales = Localization.getLocales();
    const deviceLang = locales[0]?.languageCode ?? 'es';
    initI18n(deviceLang);
  }, []);

  // Subscribe to network state changes
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setOnlineStatus(state.isConnected ?? true);
    });
    return () => unsubscribe();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <OfflineBanner />
      {children}
    </QueryClientProvider>
  );
}
