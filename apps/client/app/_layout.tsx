import React, { useEffect } from 'react';
import { Stack, useSegments, useRouter, useNavigationContainerRef } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { AppProviders } from '@/providers/app-providers';
import { useAuthStore } from '@/stores/auth.store';
import { ErrorBoundary } from '@tricigo/ui/ErrorBoundary';
import { colors } from '@tricigo/theme';
import { initSentry, Sentry } from '@/lib/sentry';
import '../global.css';

// Initialize Sentry as early as possible
initSentry();

function RootNavigator() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const segments = useSegments();
  const router = useRouter();
  const navRef = useNavigationContainerRef();

  useEffect(() => {
    if (isLoading || !navRef.isReady()) return;

    const inAuthGroup = segments[0] === '(auth)';

    if (!isAuthenticated && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (isAuthenticated && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [isAuthenticated, isLoading, segments]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background.primary }}>
        <ActivityIndicator size="large" color={colors.brand.orange} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="profile" />
      <Stack.Screen name="ride" />
      <Stack.Screen name="chat" />
      <Stack.Screen name="+not-found" />
    </Stack>
  );
}

function RootLayoutInner() {
  return (
    <ErrorBoundary>
      <AppProviders>
        <RootNavigator />
      </AppProviders>
    </ErrorBoundary>
  );
}

export default Sentry.wrap(RootLayoutInner);
