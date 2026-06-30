// ============================================================
// TriciGo Driver — Universal Link redirect for the documents
// re-upload bridge.
//
// Catches `https://tricigo.com/app/driver/profile/documents`
// when Android's universal-link delegation routes the URL into
// the driver app (intent filter `pathPrefix=/app/driver,
// autoVerify=true` from app.json). Without this file, Expo
// Router resolves the path `/app/driver/profile/documents`
// against the filesystem, finds nothing, and renders
// `+not-found.tsx` — the dark "404 / Página no encontrada"
// screen.
//
// Why this exists: the admin app pushes a notification when it
// verifies or rejects a driver document (admin.service.ts
// verifyDocument, PR #715). The push includes `cta:
// '/profile/documents'`. A future email path will use the
// universal link version of the same destination so a tap from
// Gmail lands in the app instead of the bridge web page.
//
// What it does: redirects to `/profile/documents` (the existing
// Cuban-styled documents screen with `useRefreshOnFocus` and
// the re-upload button for rejected docs).
//
// Mirrored by `apps/driver/app/app/driver/wallet.tsx` (same
// pattern for the wallet bridge).
// ============================================================

import { useEffect } from 'react';
import { router } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';

export default function ProfileDocumentsRedirect() {
  useEffect(() => {
    // Tiny delay so the splash flashes for one frame — feels
    // intentional instead of an instantaneous flip that can look
    // like a crash on slower devices.
    const t = setTimeout(() => {
      router.replace('/profile/documents');
    }, 100);
    return () => clearTimeout(t);
  }, []);

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
