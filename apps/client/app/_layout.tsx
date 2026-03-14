import React, { useEffect } from 'react';
import { Stack, useSegments, useRouter, useNavigationContainerRef } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { AppProviders } from '@/providers/app-providers';
import { useAuthStore } from '@/stores/auth.store';
import { ErrorBoundary } from '@tricigo/ui/ErrorBoundary';
import { colors } from '@tricigo/theme';
import { initSentry, Sentry } from '@/lib/sentry';
import MapboxGL from '@rnmapbox/maps';
import Toast from 'react-native-toast-message';
import { registerSoundAssets } from '@tricigo/utils';
import { useMapboxOffline } from '@/hooks/useMapboxOffline';
import '../global.css';

// Initialize Sentry as early as possible
initSentry();

// Register sound assets for ride events
registerSoundAssets({
  ride_accepted: require('../assets/sounds/ride_accepted.wav'),
  driver_arrived: require('../assets/sounds/driver_arrived.wav'),
  trip_completed: require('../assets/sounds/trip_completed.wav'),
});

// Initialize Mapbox
MapboxGL.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '');

function RootNavigator() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const segments = useSegments();

  // Download Havana offline map tiles (runs once per week)
  useMapboxOffline();
  const router = useRouter();
  const navRef = useNavigationContainerRef();

  useEffect(() => {
    if (isLoading || !navRef.isReady()) return;

    const inAuthGroup = segments[0] === '(auth)';
    // Allow deep link routes to handle their own auth redirect
    const inDeepLink = segments[0] === 'refer' || segments[0] === 'promo' || segments[0] === 'ride';

    if (!isAuthenticated && !inAuthGroup && !inDeepLink) {
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
      <Stack.Screen name="refer" />
      <Stack.Screen name="promo" />
      <Stack.Screen name="chat" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="+not-found" />
    </Stack>
  );
}

function RootLayoutInner() {
  return (
    <ErrorBoundary onError={(error) => Sentry.captureException(error)}>
      <AppProviders>
        <RootNavigator />
      </AppProviders>
      <Toast />
    </ErrorBoundary>
  );
}

export default Sentry.wrap(RootLayoutInner);
