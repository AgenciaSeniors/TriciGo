import React, { useEffect } from 'react';
import { Stack, useSegments, useRouter, useNavigationContainerRef } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { useColorScheme } from 'nativewind';
import { AppProviders } from '@/providers/app-providers';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useDriverRideStore } from '@/stores/ride.store';
import { useThemeStore, useSystemThemeSync } from '@/stores/theme.store';
import { colors } from '@tricigo/theme';
import { ErrorBoundary } from '@tricigo/ui/ErrorBoundary';
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
  trip_completed: require('../assets/sounds/trip_completed.wav'),
  new_request: require('../assets/sounds/new_request.wav'),
});

// Initialize Mapbox (try-catch to prevent crash if token is missing)
try {
  MapboxGL.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '');
} catch {
  // Mapbox will fail on map screens but app won't crash on startup
}

function RootNavigator() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const driverProfile = useDriverStore((s) => s.profile);
  const isProfileLoaded = useDriverStore((s) => s.isProfileLoaded);
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const segments = useSegments();

  // Dark mode: sync NativeWind color scheme with theme store
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const { setColorScheme } = useColorScheme();
  useSystemThemeSync();

  useEffect(() => {
    setColorScheme(resolvedScheme);
  }, [resolvedScheme, setColorScheme]);

  // Download Havana offline map tiles (runs once per week)
  useMapboxOffline();
  const router = useRouter();
  const navRef = useNavigationContainerRef();

  useEffect(() => {
    if (isLoading || !navRef.isReady()) return;

    const inAuthGroup = segments[0] === '(auth)';
    const inOnboarding = segments[0] === 'onboarding';

    // Not authenticated → login
    if (!isAuthenticated && !inAuthGroup) {
      router.replace('/(auth)/login');
      return;
    }

    // Wait until the driver profile fetch has completed before making
    // routing decisions. Without this guard, the router sees
    // driverProfile=null (not yet loaded) and wrongly redirects to onboarding
    // even for approved drivers who just logged in.
    if (isAuthenticated && !isProfileLoaded) return;

    // Authenticated but in auth group → redirect based on profile state
    if (isAuthenticated && inAuthGroup) {
      if (!driverProfile || driverProfile.status === 'pending_verification') {
        router.replace('/onboarding/personal-info');
      } else if (driverProfile.status === 'approved') {
        router.replace('/(tabs)');
      } else {
        router.replace('/onboarding/pending');
      }
      return;
    }

    // Authenticated, no profile or pending_verification → onboarding
    if (
      isAuthenticated &&
      (!driverProfile || driverProfile.status === 'pending_verification') &&
      !inOnboarding
    ) {
      router.replace('/onboarding/personal-info');
      return;
    }

    // Authenticated, profile not approved → pending
    // But allow completing an active trip first (e.g., if admin suspends mid-ride)
    if (
      isAuthenticated &&
      driverProfile &&
      driverProfile.status !== 'approved' &&
      driverProfile.status !== 'pending_verification' &&
      !inOnboarding &&
      !activeTrip
    ) {
      router.replace('/onboarding/pending');
    }
  }, [isAuthenticated, isLoading, isProfileLoaded, driverProfile, segments]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.neutral[900] }}>
        <ActivityIndicator size="large" color={colors.brand.orange} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="profile" />
      <Stack.Screen name="trip" />
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
        <Toast />
      </AppProviders>
    </ErrorBoundary>
  );
}

export default Sentry.wrap(RootLayoutInner);
