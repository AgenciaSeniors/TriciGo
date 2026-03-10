import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { initI18n } from '@tricigo/i18n';
import * as Localization from 'expo-localization';
import { useAuthInit } from '@/hooks/useAuth';
import { useNotificationSetup } from '@/hooks/useNotifications';
import { useAuthStore } from '@/stores/auth.store';

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

export function AppProviders({ children }: { children: React.ReactNode }) {
  useAuthInit();
  const user = useAuthStore((s) => s.user);
  useNotificationSetup(user?.id);

  useEffect(() => {
    const locales = Localization.getLocales();
    const deviceLang = locales[0]?.languageCode ?? 'es';
    initI18n(deviceLang);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
