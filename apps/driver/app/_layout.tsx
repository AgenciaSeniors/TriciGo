import React from 'react';
import { Stack, Redirect, useSegments } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { AppProviders } from '@/providers/app-providers';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { colors } from '@tricigo/theme';
import { ErrorBoundary } from '@tricigo/ui/ErrorBoundary';
import { initSentry, Sentry } from '@/lib/sentry';
import '../global.css';

// Initialize Sentry as early as possible
initSentry();

function RootNavigator() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const driverProfile = useDriverStore((s) => s.profile);
  const segments = useSegments();

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111111' }}>
        <ActivityIndicator size="large" color={colors.brand.orange} />
      </View>
    );
  }

  const inAuthGroup = segments[0] === '(auth)';
  const inOnboarding = segments[0] === 'onboarding';

  // Not authenticated → login
  if (!isAuthenticated && !inAuthGroup) {
    return <Redirect href="/(auth)/login" />;
  }

  // Authenticated but in auth group → redirect based on profile state
  if (isAuthenticated && inAuthGroup) {
    if (!driverProfile || driverProfile.status === 'pending_verification') {
      return <Redirect href="/onboarding/personal-info" />;
    }
    if (driverProfile.status === 'approved') {
      return <Redirect href="/(tabs)" />;
    }
    return <Redirect href="/onboarding/pending" />;
  }

  // Authenticated, no profile or pending_verification → onboarding
  if (
    isAuthenticated &&
    (!driverProfile || driverProfile.status === 'pending_verification') &&
    !inOnboarding
  ) {
    return <Redirect href="/onboarding/personal-info" />;
  }

  // Authenticated, profile not approved (under_review/rejected/suspended) → pending
  if (
    isAuthenticated &&
    driverProfile &&
    driverProfile.status !== 'approved' &&
    driverProfile.status !== 'pending_verification' &&
    !inOnboarding
  ) {
    return <Redirect href="/onboarding/pending" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="profile" />
      <Stack.Screen name="trip" />
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
