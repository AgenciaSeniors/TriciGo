// ============================================================
// TriciGo Client — Universal Link redirect for the CORPORATE wallet
// recharge return.
//
// Catches `https://tricigo.com/app/client/profile/corporate?intent=<id>`
// when Android's universal-link delegation routes the URL into the
// client app (intent filter `pathPrefix=/app/client, autoVerify=true`
// from app.json). Without this file, Expo Router resolves the path
// `/app/client/profile/corporate` against the filesystem, finds
// nothing, and renders `+not-found.tsx` — the dark "404" screen.
//
// Same bug pattern as `app/app/client/wallet.tsx` (2026-05-24, PR #184)
// and `app/app/driver/wallet.tsx` (PR #190). PR-CORP-2 mirrors the
// pattern for corporate wallet recharges.
//
// What it does:
//   1. Reads `?intent=<id>` from the URL (forwarded by NETOPIA).
//   2. Replaces the navigation stack with `/profile/corporate` so the
//      client lands on the corporate panel where the recharge effect
//      polls intent status and refreshes balance.
// ============================================================

import { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';

export default function ClientCorporateUniversalLinkRedirect() {
  const { intent } = useLocalSearchParams<{ intent?: string }>();

  useEffect(() => {
    const t = setTimeout(() => {
      const target = intent
        ? `/profile/corporate?intent=${encodeURIComponent(intent)}`
        : '/profile/corporate';
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
