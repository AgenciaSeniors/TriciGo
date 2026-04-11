import React, { useCallback, useEffect } from 'react';
import { Stack, useSegments, useRouter, useNavigationContainerRef } from 'expo-router';
import { View, ActivityIndicator, Platform } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useFonts } from 'expo-font';
import {
  Montserrat_400Regular,
  Montserrat_500Medium,
  Montserrat_600SemiBold,
  Montserrat_700Bold,
  Montserrat_800ExtraBold,
} from '@expo-google-fonts/montserrat';
import * as SplashScreen from 'expo-splash-screen';
import { AppProviders } from '@/providers/app-providers';
import { useAuthStore } from '@/stores/auth.store';
import { useThemeStore, useSystemThemeSync } from '@/stores/theme.store';
import { ErrorBoundary } from '@tricigo/ui/ErrorBoundary';
import { colors } from '@tricigo/theme';
import { initSentry, Sentry } from '@/lib/sentry';
import Toast from 'react-native-toast-message';
import { registerSoundAssets } from '@tricigo/utils';
import { useMapboxOffline } from '@/hooks/useMapboxOffline';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import { registerForPushNotifications } from '@/services/push.service';
import '../global.css';

// Initialize Sentry as early as possible (safe for web)
try { initSentry(); } catch { /* Sentry init failed — non-fatal */ }

// Register sound assets for ride events (native only — .wav files don't resolve on web)
if (Platform.OS !== 'web') {
  try {
    registerSoundAssets({
      ride_accepted: require('../assets/sounds/ride_accepted.wav'),
      driver_arrived: require('../assets/sounds/driver_arrived.wav'),
      trip_completed: require('../assets/sounds/trip_completed.wav'),
      destination_arrived: require('../assets/sounds/trip_completed.wav'),
    });
  } catch { /* Sound registration failed — non-fatal */ }
}

// Initialize Mapbox (native only — @rnmapbox/maps has no web support)
if (Platform.OS !== 'web') {
  try {
    const MapboxGL = require('@rnmapbox/maps').default;
    MapboxGL.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '');
  } catch {
    // Mapbox will fail on map screens but app won't crash on startup
  }
}

function RootNavigator() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
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

  // Process offline queue when connectivity is restored
  useOfflineSync();

  // Register for push notifications on mount
  useEffect(() => {
    registerForPushNotifications();
  }, []);
  const router = useRouter();
  const navRef = useNavigationContainerRef();

  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (isLoading || !navRef.isReady()) return;

    const inAuthGroup = segments[0] === '(auth)';
    // Allow public deep link routes (referrals, promos) without auth
    const inPublicDeepLink = segments[0] === 'refer' || segments[0] === 'promo';

    if (!isAuthenticated && !inAuthGroup && !inPublicDeepLink) {
      router.replace('/(auth)/login');
    } else if (isAuthenticated && inAuthGroup) {
      // Check if profile is incomplete (new user needs to complete profile)
      if (!user?.full_name) {
        const currentRoute = segments.join('/');
        if (!currentRoute.includes('complete-profile') && !currentRoute.includes('verify-phone')) {
          router.replace('/(auth)/complete-profile');
          return;
        }
        return;
      }
      // Check if phone is missing (social login user)
      if (!user?.phone) {
        const currentRoute = segments.join('/');
        if (!currentRoute.includes('verify-phone')) {
          router.replace('/(auth)/verify-phone');
          return;
        }
        return;
      }
      router.replace('/(tabs)');
    }
  }, [isAuthenticated, isLoading, segments, user?.full_name, user?.phone]);

  if (isLoading) {
    const bgColor = resolvedScheme === 'dark' ? colors.background.dark : colors.background.primary;
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: bgColor }}>
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
      <Stack.Screen name="driver-profile" />
      <Stack.Screen name="support" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="+not-found" />
    </Stack>
  );
}

// Keep splash screen visible while loading fonts
SplashScreen.preventAutoHideAsync().catch(() => {});

function RootLayoutInner() {
  const [fontsLoaded] = useFonts({
    Montserrat_400Regular,
    Montserrat_500Medium,
    Montserrat_600SemiBold,
    Montserrat_700Bold,
    Montserrat_800ExtraBold,
  });

  const onLayoutReady = useCallback(async () => {
    if (fontsLoaded) {
      await SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  useEffect(() => {
    onLayoutReady();
  }, [onLayoutReady]);

  if (!fontsLoaded) {
    return null;
  }

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
