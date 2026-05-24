// ============================================================
// TriciGo Driver — Universal Link redirect for the wallet bridge
//
// Catches `https://tricigo.com/app/driver/wallet?intent=<id>` when
// Android's universal-link delegation routes the URL into the driver
// app (intent filter `pathPrefix=/app/driver, autoVerify=true` from
// app.json). Without this file, Expo Router resolves the path
// `/app/driver/wallet` against the filesystem, finds nothing, and
// renders `+not-found.tsx` — the dark "404 / Página no encontrada"
// screen observed 2026-05-24 after PR #184 (driver recharge flow).
//
// What it does:
//   1. Reads `?intent=<id>` from the URL (forwarded by NETOPIA after
//      a successful payment).
//   2. Replaces the navigation stack with `/(tabs)/wallet` so the
//      driver lands on the wallet tab where the new balance is
//      already credited by the server-side webhook.
//   3. While the redirect is queued (one frame), shows a brief
//      spinner over the same dark background as the rest of the app
//      so the transition doesn't flash white.
//
// The `recharge.tsx` flow that opened the WebBrowser was awaiting
// `dismissUrl`. Universal-link delegation interrupts that wait — the
// browser closes, control returns to the driver app via THIS route
// (not back to recharge.tsx). Recharge.tsx's polling logic does not
// run in that case, but the toast is non-essential: the user sees
// their updated balance directly in the wallet tab.
//
// Mirrored by `apps/client/app/app/client/wallet.tsx` (same fix for
// the client app's `/app/client/*` universal link).
// ============================================================

import { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';

export default function DriverUniversalLinkRedirect() {
  const { intent } = useLocalSearchParams<{ intent?: string }>();

  useEffect(() => {
    // Tiny delay so the splash flashes for one frame — feels
    // intentional instead of an instantaneous flip that can look
    // like a crash on slower devices.
    const t = setTimeout(() => {
      const target = intent
        ? `/(tabs)/wallet?intent=${encodeURIComponent(intent)}`
        : '/(tabs)/wallet';
      router.replace(target);
    }, 100);
    return () => clearTimeout(t);
  }, [intent]);

  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#0a0a0a',
      }}
    >
      <ActivityIndicator size="large" color="#ff6a00" />
    </View>
  );
}
