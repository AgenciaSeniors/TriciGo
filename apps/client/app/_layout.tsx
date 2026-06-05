import React, { useCallback, useEffect } from 'react';
import { Stack, useSegments, useRouter, useNavigationContainerRef } from 'expo-router';
import { View, ActivityIndicator, Platform, Alert, LogBox, AppState } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useFonts } from 'expo-font';
import {
  Montserrat_400Regular,
  Montserrat_500Medium,
  Montserrat_600SemiBold,
  Montserrat_700Bold,
  Montserrat_800ExtraBold,
} from '@expo-google-fonts/montserrat';
import {
  BricolageGrotesque_500Medium,
  BricolageGrotesque_600SemiBold,
  BricolageGrotesque_700Bold,
} from '@expo-google-fonts/bricolage-grotesque';
import { InstrumentSerif_400Regular_Italic, InstrumentSerif_400Regular } from '@expo-google-fonts/instrument-serif';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
} from '@expo-google-fonts/jetbrains-mono';
import * as SplashScreen from 'expo-splash-screen';
import { AppProviders } from '@/providers/app-providers';
import { useAuthStore } from '@/stores/auth.store';
import { useThemeStore, useSystemThemeSync } from '@/stores/theme.store';
import { ErrorBoundary } from '@tricigo/ui/ErrorBoundary';
import { DemoBanner } from '@/components/DemoBanner';
import { AnimatedSplash } from '@/components/AnimatedSplash';
import { colors } from '@tricigo/theme';
import { getSupabaseClient } from '@tricigo/api';
import { initSentry, Sentry } from '@/lib/sentry';
import Toast from 'react-native-toast-message';
import { registerSoundAssets, setupRuntimeLogging } from '@tricigo/utils';
import { useDynamicOfflineMap } from '@/hooks/useDynamicOfflineMap';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import { registerForPushNotifications } from '@/services/push.service';
import { useRideInit } from '@/hooks/useRide';
import '../global.css';

// Silence known-benign runtime warnings (ExpoKeepAwake / expo-av / SafeAreaView
// / push token network failure). MUST run before initSentry so the rejection
// tracker is installed first. See setupRuntimeLogging.native.ts for details.
try { setupRuntimeLogging(); } catch { /* setup failed — non-fatal */ }

// Initialize Sentry as early as possible (safe for web)
try { initSentry(); } catch { /* Sentry init failed — non-fatal */ }

// DEBUG: Global error handler — shows Alert with crash details
if (Platform.OS !== 'web') {
  const originalHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error: Error, isFatal?: boolean) => {
    try {
      Alert.alert(
        isFatal ? 'FATAL ERROR' : 'ERROR',
        `${error?.name}: ${error?.message}\n\nStack: ${error?.stack?.substring(0, 300)}`,
        [{ text: 'OK' }],
      );
    } catch { /* Alert itself might fail */ }
    originalHandler(error, isFatal);
  });
}

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
// Runs at module load AND again in useEffect inside RootNavigator —
// release builds sometimes lose the race between the module side-effect
// and native MapView mounting, so the useEffect guarantees the token is
// set before any map tries to render.
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

  // Re-initialize Mapbox after React mounts — belt + suspenders with
  // the module-level initMapbox() above.
  useEffect(() => {
    initMapbox();
  }, []);

  // Supabase RN token lifecycle (realtime CHANNEL_ERROR hardening). On React
  // Native, `autoRefreshToken: true` alone does NOT reliably refresh the
  // session while backgrounded (JS timers are throttled/suspended). The
  // documented Supabase pattern drives the auto-refresh loop with AppState:
  // start it while foregrounded, stop it when backgrounded. Without this the
  // access token can expire in the background; on foreground the realtime
  // socket reconnects and rejoins channels with a stale token -> CHANNEL_ERROR.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const supabase = getSupabaseClient();
    supabase.auth.startAutoRefresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        supabase.auth.startAutoRefresh();
      } else {
        supabase.auth.stopAutoRefresh();
      }
    });
    return () => {
      sub.remove();
      supabase.auth.stopAutoRefresh();
    };
  }, []);

  // Dynamic offline maps: download the current grid cell on demand,
  // nationwide, under Mapbox's per-device tile budget.
  useDynamicOfflineMap();

  // Process offline queue when connectivity is restored
  useOfflineSync();

  // Register for push notifications on mount
  useEffect(() => {
    registerForPushNotifications();
  }, []);

  // BUG-253 (Capa 3.1): mount the ride watcher at the root layout so
  // the 3-second polling + AppState foreground listener stay alive even
  // when the user navigates away from the home tab. Previously the
  // watcher was inside NativeHomeScreen and died on tab change, leaving
  // stale local state that the watcher would have cleared.
  useRideInit();

  const router = useRouter();
  const navRef = useNavigationContainerRef();

  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (isLoading || !navRef.isReady()) return;

    const inAuthGroup = segments[0] === '(auth)';
    // Allow public deep link routes (referrals, promos) without auth
    const inPublicDeepLink = segments[0] === 'refer' || segments[0] === 'promo';
    const currentRoute = segments.join('/');

    if (!isAuthenticated && !inAuthGroup && !inPublicDeepLink) {
      router.replace('/(auth)/login');
      return;
    }

    // BUG-207 (7): the previous version guarded `!user?.full_name` and
    // `!user?.phone` ONLY inside the `inAuthGroup` branch. If a user
    // signed in with Google but exited the app before completing the
    // verify-phone step, the next launch restored the session straight
    // into `/(tabs)` (segments[0] === '(tabs)'), so `inAuthGroup` was
    // false and the onboarding guards were skipped — they entered the
    // app with a partial profile.
    //
    // Now we run the completeness checks for ANY authenticated user
    // regardless of route. Public deep links still pass through (they
    // exit the function early above when unauthenticated; if the user is
    // authenticated and on /refer or /promo we let them stay there
    // since those screens handle missing-profile state themselves).
    if (isAuthenticated && !inPublicDeepLink) {
      if (!user?.full_name) {
        if (!currentRoute.includes('complete-profile') && !currentRoute.includes('verify-phone')) {
          router.replace('/(auth)/complete-profile');
        }
        return;
      }
      if (!user?.phone) {
        if (!currentRoute.includes('verify-phone')) {
          router.replace('/(auth)/verify-phone');
        }
        return;
      }
      // Profile complete — if user is stuck inside the auth group (e.g.
      // they finished verify-phone and the navigator hasn't moved them
      // out yet), kick them to the main app.
      if (inAuthGroup) {
        router.replace('/(tabs)');
      }
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
      {/* BUG-294: route name must match the actual registered route
          (notifications/index.tsx → 'notifications/index'). Was emitting
          a `[Layout children]: No route named "notifications"` warning
          on every Stack reconcile. */}
      <Stack.Screen name="notifications/index" />
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
    BricolageGrotesque_500Medium,
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_700Bold,
    InstrumentSerif_400Regular,
    InstrumentSerif_400Regular_Italic,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_600SemiBold,
  });

  const onLayoutReady = useCallback(async () => {
    if (fontsLoaded) {
      await SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  useEffect(() => {
    onLayoutReady();
  }, [onLayoutReady]);

  // BUG-289 — keep AnimatedSplash visible 2.5s after fonts load so the
  // pulse + dot loader + tagline have time to read. Was 1.2s but felt
  // rushed (200ms fade-in + ~700ms visible + 250ms fade-out = ~1s total).
  // 2500ms gives ~2s of fully visible polished splash before fade-out.
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
    <ErrorBoundary onError={(error) => {
        Sentry.captureException(error);
        if (Platform.OS !== 'web') {
          Alert.alert('App Error', `${error?.name}: ${error?.message}\n\n${error?.stack?.substring(0, 300)}`);
        }
      }}>
      <AppProviders>
        {/* StripeBootstrap wrapper removed 2026-05-21 (post NETOPIA cutover).
            Mobile recharge runs through WebBrowser.openAuthSessionAsync against
            NETOPIA's hosted page — no native SDK provider needed. */}
        <RootNavigator />
        {/* DemoBanner only renders when EXPO_PUBLIC_DEMO_MODE=true.
            Otherwise it returns null — zero overhead in prod builds. */}
        <DemoBanner />
        <Toast />
      </AppProviders>
      {/* BUG-289 — animated splash overlay (orange gradient, white pin
          + wordmark, dot loader, "Cuba" tagline). Sits above everything
          and fades out 250ms after splashVisible flips to false. */}
      <AnimatedSplash
        visible={splashVisible}
        variant="client"
        tagline="Cuba"
        pinSource={require('../assets/adaptive-icon.png')}
        wordmarkSource={require('../assets/logo-wordmark-white.png')}
      />
    </ErrorBoundary>
  );
}

export default Sentry.wrap(RootLayoutInner);
