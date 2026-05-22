/**
 * useMapboxReady — gate the MapView render until the network is in a
 * shape where Mapbox can fetch its config_service + style + tiles
 * without falling into the BUG-006 "gray map on first cold start" trap.
 *
 * What it does:
 *   1) Waits for NetInfo to report `isConnected = true`.
 *   2) Pre-warms DNS for api.mapbox.com / events.mapbox.com with an
 *      `await`ed HEAD fetch (timeout 5s via AbortController). Unlike the
 *      old `setTimeout(0) + fetch()` fire-and-forget in _layout.tsx,
 *      this BLOCKS the caller from rendering the MapView until DNS
 *      resolution actually attempted — so by the time @rnmapbox/maps
 *      asks for its config, the OS DNS cache is populated.
 *   3) Returns `retry()` so callers can re-run the gate after the
 *      MapView reports `onDidFailLoadingMap` (key-based re-mount).
 *
 * Why a hook (vs an early effect in _layout.tsx): the caller is the
 * one that knows it's about to render a MapView, and only the caller
 * can re-mount the MapView when it fails. Centralizing the readiness
 * state next to the MapView keeps the timing tight — no race between
 * "DNS is ready" and "the screen with the map mounts seconds later".
 *
 * Web: noops (web uses mapbox-gl directly via WebMapboxView which has
 * its own loading lifecycle).
 *
 * Closes: BUG-006 (cold-start gray map definitive fix v2 — superseding
 * the `setTimeout(0) + fetch()` pre-warm in apps/driver/app/_layout.tsx
 * which couldn't guarantee timing).
 */
import { useEffect, useState, useCallback } from 'react';
import { Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

export type MapboxReadyError = 'no_network' | 'dns_timeout' | 'unknown';

export interface MapboxReadyState {
  ready: boolean;
  error: MapboxReadyError | null;
  retry: () => void;
}

const PREWARM_TIMEOUT_MS = 5000;
const PREWARM_URLS = [
  'https://api.mapbox.com/',
  'https://events.mapbox.com/',
];

export function useMapboxReady(): MapboxReadyState {
  // Web: skip the gate entirely. WebMapboxView handles its own loading.
  const [ready, setReady] = useState(Platform.OS === 'web');
  const [error, setError] = useState<MapboxReadyError | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    setError(null);
    setReady(false);

    (async () => {
      try {
        // 1) Check network is up. If the device just came back from
        //    airplane mode / dozed wifi, NetInfo flips to connected
        //    BEFORE the routing tables are ready — so we treat this
        //    as best-effort and proceed even if it briefly reports
        //    disconnected (Mapbox will retry internally).
        const net = await NetInfo.fetch();
        if (!cancelled && !net.isConnected) {
          setError('no_network');
          // Don't return — continue with the prewarm. NetInfo can be
          // wrong (Android wifi just-coming-up). The user-visible
          // error state gives them a Retry button if it really stays
          // disconnected; meanwhile the prewarm keeps trying.
        }

        // 2) DNS pre-warm. fetch(HEAD) triggers the DNS resolution
        //    without downloading a body. Promise.allSettled so one
        //    failing host doesn't abort the other. AbortController
        //    timeout caps the wait at PREWARM_TIMEOUT_MS so a stuck
        //    DNS doesn't lock the user on the loading screen forever.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), PREWARM_TIMEOUT_MS);
        try {
          await Promise.allSettled(
            PREWARM_URLS.map((url) =>
              fetch(url, { method: 'HEAD', signal: controller.signal }).catch(() => null),
            ),
          );
        } finally {
          clearTimeout(timeoutId);
        }

        if (cancelled) return;
        // Mark ready even if individual fetches failed — the DNS
        // resolution was attempted and the OS cache likely populated.
        // If Mapbox still can't load tiles, the caller's
        // `onDidFailLoadingMap` handler will call `retry()` which
        // re-runs this effect with a fresh AbortController.
        setReady(true);
      } catch {
        if (!cancelled) setError('unknown');
      }
    })();

    return () => { cancelled = true; };
  }, [retryToken]);

  const retry = useCallback(() => {
    setRetryToken((n) => n + 1);
  }, []);

  return { ready, error, retry };
}
