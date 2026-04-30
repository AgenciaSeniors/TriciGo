import React, { useCallback, useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, useSegments, useRouter, useNavigationContainerRef } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useFonts } from 'expo-font';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';
import * as SplashScreen from 'expo-splash-screen';
import { AppProviders } from '@/providers/app-providers';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useDriverRideStore } from '@/stores/ride.store';
import { useLocationStore } from '@/stores/location.store';
import { useThemeStore, useSystemThemeSync } from '@/stores/theme.store';
import { colors } from '@tricigo/theme';
import { ErrorBoundary } from '@tricigo/ui/ErrorBoundary';
import { DemoBanner } from '@/components/DemoBanner';
import { initSentry, Sentry } from '@/lib/sentry';
import Toast from 'react-native-toast-message';
import { registerSoundAssets } from '@tricigo/utils';
import { useMapboxOffline } from '@/hooks/useMapboxOffline';
import { useAuthDeepLink } from '@/hooks/useAuthDeepLink';
import { AnimatedSplash } from '@/components/AnimatedSplash';
import { Platform } from 'react-native';
import '../global.css';

// Initialize Sentry as early as possible (safe for web)
try { initSentry(); } catch { /* Sentry init failed — non-fatal */ }

// Register sound assets for ride events (native only — .wav files don't resolve on web)
if (Platform.OS !== 'web') {
  try {
    registerSoundAssets({
      ride_accepted: require('../assets/sounds/ride_accepted.wav'),
      trip_completed: require('../assets/sounds/trip_completed.wav'),
      new_request: require('../assets/sounds/new_request.wav'),
    });
  } catch { /* Sound registration failed — non-fatal */ }
}

// Initialize Mapbox (native only — @rnmapbox/maps has no web support)
// The setAccessToken call runs both at module load AND in a useEffect
// inside RootNavigator — in release builds the module-level side effect
// can sometimes lose the race with native MapView instantiation, so the
// useEffect guarantees the token is set before any map tries to render.
function initMapbox() {
  if (Platform.OS === 'web') return;
  try {
    const MapboxGL = require('@rnmapbox/maps').default;
    const token = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
    MapboxGL.setAccessToken(token);
    // BUG-216: setWellKnownTileServer removed (deprecated in newer
    // @rnmapbox/maps; tile server auto-detected from access token).
    if (typeof MapboxGL.setTelemetryEnabled === 'function') {
      MapboxGL.setTelemetryEnabled(false);
    }
  } catch {
    // Mapbox will fail on map screens but app won't crash on startup
  }
}
initMapbox();

/**
 * BUG-006 (cold-start gray map definitive fix): pre-warm Android's
 * DNS resolver so Mapbox can fetch its config_service on first launch.
 *
 * Forensic evidence (logcat after `pm clear` cold start):
 *   10:09:13.751  MapboxInitializer create()
 *   10:09:15.944  tile_store: Creating new database (cache empty)
 *   10:09:16.072  W Mapbox config_service: Unable to fetch configuration
 *                  HTTP error: net::ERR_NAME_NOT_RESOLVED, attempt 0 of 2
 *
 * Mapbox retries only 2 times then gives up — the map renders gray
 * because no style/glyphs/tiles can be downloaded. After the user
 * closes and reopens the app, Android's DNS cache still holds the
 * api.mapbox.com → IP mapping, so the second launch works.
 *
 * Fix: kick off two no-op fetches as soon as the JS bundle loads.
 * They're fire-and-forget — we only need the side effect of populating
 * the OS DNS resolver cache. By the time React mounts and a MapView
 * tries to fetch its style, api.mapbox.com is resolved.
 *
 * setTimeout(0) instead of immediate so we don't block module init on
 * non-essential network. Two hosts: api.mapbox.com (config + tiles)
 * and events.mapbox.com (telemetry — even though we disable it, RN
 * Mapbox still pings it on first launch).
 */
if (Platform.OS !== 'web') {
  setTimeout(() => {
    fetch('https://api.mapbox.com/').catch(() => { /* DNS warm only */ });
    fetch('https://events.mapbox.com/').catch(() => { /* DNS warm only */ });
  }, 0);
}

function RootNavigator() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const driverProfile = useDriverStore((s) => s.profile);
  const isProfileLoaded = useDriverStore((s) => s.isProfileLoaded);
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const segments = useSegments();

  // Handle OAuth deep link callbacks (tricigo-driver://auth/callback)
  useAuthDeepLink();

  // Dark mode: sync NativeWind color scheme with theme store
  // Driver app uses forced dark backgrounds (Screen bg="dark") with light NativeWind
  // so that color="inverse" gives white text on dark bg.
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const { setColorScheme } = useColorScheme();
  useSystemThemeSync();

  useEffect(() => {
    setColorScheme(resolvedScheme);
    // Remove dark class if it was previously set, to avoid conflicts
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.classList.remove('dark');
    }
  }, [resolvedScheme, setColorScheme]);

  // Re-initialize Mapbox after React mounts — ensures the token is set
  // before any MapView renders, belt + suspenders with the module-level
  // initMapbox() call above.
  useEffect(() => {
    initMapbox();
  }, []);

  // Request foreground GPS permission early and seed useLocationStore with
  // an initial fix so the map centers on the real user location instead of
  // staying on the demo/Havana fallback. Tries getLastKnownPositionAsync first
  // (instant if cached), then getCurrentPositionAsync at Low accuracy (wifi/cell,
  // not waiting for satellite lock). Non-blocking: on failure, map uses fallback.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    (async () => {
      try {
        const Location = await import('expo-location');
        const perm = await Location.requestForegroundPermissionsAsync();
        console.log('[DriverLocation] permission status:', perm.status);
        if (perm.status !== 'granted' || cancelled) return;

        // Fast path: last known position (cached by OS from recent GPS use)
        try {
          const last = await Location.getLastKnownPositionAsync({
            maxAge: 60 * 60 * 1000,   // up to 1h old
            requiredAccuracy: 500,    // ≤500m horizontal accuracy
          });
          if (last && !cancelled) {
            console.log('[DriverLocation] last known fix:', last.coords.latitude, last.coords.longitude);
            useLocationStore.getState().setLocation(
              last.coords.latitude,
              last.coords.longitude,
              last.coords.heading ?? null,
            );
          }
        } catch (e) {
          console.log('[DriverLocation] getLastKnownPositionAsync error:', String(e));
        }

        // Fresh fix: low accuracy is fast (wifi/cell, no satellite wait)
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Low,
        });
        if (cancelled) return;
        console.log('[DriverLocation] current fix:', pos.coords.latitude, pos.coords.longitude);
        useLocationStore.getState().setLocation(
          pos.coords.latitude,
          pos.coords.longitude,
          pos.coords.heading ?? null,
        );
      } catch (err) {
        console.log('[DriverLocation] startup fix failed:', String(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

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

// Keep splash screen visible while loading fonts
SplashScreen.preventAutoHideAsync().catch(() => {});

function RootLayoutInner() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
  });

  const onLayoutReady = useCallback(async () => {
    if (fontsLoaded) {
      await SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  useEffect(() => {
    onLayoutReady();
  }, [onLayoutReady]);

  // BUG-289 — keep the AnimatedSplash overlay visible for 2.5 s after
  // fonts load so the pulse + dot loader + tagline have time to read.
  // Was 1.2s but felt rushed once the polished design was in place.
  const [splashVisible, setSplashVisible] = React.useState(true);
  useEffect(() => {
    if (!fontsLoaded) return;
    const t = setTimeout(() => setSplashVisible(false), 2500);
    return () => clearTimeout(t);
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary onError={(error) => Sentry.captureException(error)}>
        <AppProviders>
          <RootNavigator />
          {/* Only shows when EXPO_PUBLIC_DEMO_MODE=true. */}
          <DemoBanner />
          <Toast />
        </AppProviders>
      </ErrorBoundary>
      {/* BUG-289 — branded animated splash overlay. Renders ABOVE the
          AppProviders so it covers any cold-start flicker, fades out
          once fonts are loaded + a short hold (so the pulse plays). */}
      <AnimatedSplash
        visible={splashVisible}
        variant="driver"
        tagline="Modo conductor · Cuba"
        pinSource={require('../assets/adaptive-icon.png')}
        wordmarkSource={require('../assets/logo-wordmark-white.png')}
      />
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(RootLayoutInner);
