// ============================================================
// TriciGo Client — Universal Link redirect for the wallet bridge
//
// Catches `https://tricigo.com/app/client/wallet?intent=<id>` when
// Android's universal-link delegation routes the URL into the client
// app (intent filter `pathPrefix=/app/client, autoVerify=true` from
// app.json). Without this file, Expo Router resolves the path
// `/app/client/wallet` against the filesystem, finds nothing, and
// renders `+not-found.tsx` — the dark "404 / Página no encontrada"
// screen.
//
// This is the same bug that hit the driver app on 2026-05-24 (post
// PR #184). The client app had it latent for months but never
// surfaced because the user manually toggled off
// "Open supported links" for tricigo.com in Android settings
// ("Disabled: tricigo.com" in pm get-app-links), so the OS fell back
// to opening the URL in the in-app browser → web bridge served
// the recovery page. Once a user re-enables the setting (or installs
// the APK fresh), this 404 would appear.
//
// Mirrored from `apps/driver/app/app/driver/wallet.tsx`.
//
// What it does:
//   1. Reads `?intent=<id>` from the URL (forwarded by NETOPIA).
//   2. Replaces the navigation stack with `/(tabs)/wallet` so the
//      client lands on the wallet tab where the credit is visible.
// ============================================================

import { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';

export default function ClientUniversalLinkRedirect() {
  const { intent } = useLocalSearchParams<{ intent?: string }>();

  useEffect(() => {
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
