import { useEffect, useState, useRef } from 'react';
import { getSupabaseClient } from '@tricigo/api';
import {
  cacheDriverPosition,
  getCachedDriverPosition,
  clearDriverPositionCache,
} from '@/services/driverPositionCache';

export interface DriverPosition {
  latitude: number;
  longitude: number;
  heading: number | null;
  // BUG-256: speed (m/s) lets the client dead-reckon between samples so the
  // marker keeps moving in real time even when the network is slow.
  speed?: number | null;
  // Wall-clock time of the GPS fix (server side). Used to decay extrapolation.
  recordedAt?: number;
}

export interface DriverPositionState {
  position: DriverPosition | null;
  /** True when position comes from cache (no fresh realtime data yet). */
  isCached: boolean;
  /** Timestamp of the cached position (if isCached). */
  cachedAt: number | null;
}

export function useDriverPosition(rideId: string | null): DriverPosition | null {
  const state = useDriverPositionWithCache(rideId);
  return state.position;
}

/**
 * Enhanced driver position hook that falls back to cached position
 * when offline or before realtime data arrives.
 */
export function useDriverPositionWithCache(rideId: string | null): DriverPositionState {
  const [state, setState] = useState<DriverPositionState>({
    position: null,
    isCached: false,
    cachedAt: null,
  });
  const hasRealtimeRef = useRef(false);

  // Load cached position on mount
  useEffect(() => {
    if (!rideId) {
      setState({ position: null, isCached: false, cachedAt: null });
      hasRealtimeRef.current = false;
      return;
    }

    hasRealtimeRef.current = false;

    getCachedDriverPosition(rideId).then((cached) => {
      if (cached && !hasRealtimeRef.current) {
        setState({
          position: {
            latitude: cached.latitude,
            longitude: cached.longitude,
            heading: cached.heading,
          },
          isCached: true,
          cachedAt: cached.timestamp,
        });
      }
    }).catch(() => { /* best effort */ });
  }, [rideId]);

  // BUG-277 — Realtime DISABLED. Polling-only architecture.
  //
  // Forensic evidence (Supabase logs 2026-04-28 02:38–02:39):
  //   - Driver upload gaps of 47.9s, 23.2s, 9.0s, 8.0s, 6.7s
  //   - Network: 810 Mbps WiFi 6, ping 30ms 0% loss, curl POST = 102ms
  //   - Server: 0 errors, 0 5xx, 100% of POSTs that ARRIVED returned 200/204
  //   - Conclusion: POSTs were not arriving at all during gaps
  //
  // Root cause: OkHttp `maxRequestsPerHost = 5` (RN Android default).
  // The WebSocket realtime channel holds 1 slot indefinitely. With heartbeat
  // + update_driver_position + driver_profiles GET + rides GET + buffer flush
  // running in parallel, the pool saturates. New POSTs queue and time out.
  //
  // Fix: drop the WebSocket subscription entirely. Polling at 1 Hz already
  // delivers position with the same effective freshness, frees one connection
  // slot, and removes the auto-reconnect storm that re-saturates the pool.
  //
  // Old code: `subscribeOnce()` + circuit breaker (BUG-252, BUG-261) — kept
  // out of the build. If realtime is ever re-enabled, restore from git
  // history at this file's previous revision.
  useEffect(() => {
    if (!rideId) return;

    const supabase = getSupabaseClient();
    let cancelled = false;

    // BUG-227: polling fallback. The realtime channel for
    // ride_location_events is unstable in some environments (CHANNEL_ERROR
    // loop). Without driver position the client UI gets stuck on
    // "Esperando ubicación del conductor". We query the assigned driver's
    // current_location directly. This is the same data source the driver
    // app writes to via updateLocation().
    //
    // BUG-269 v2 — back to the RPC, simpler & proven path.
    //
    // The previous attempt (PostgREST direct + EWKB hex parsing) added a
    // ton of complexity and the marker stopped moving entirely (likely
    // hex format mismatch). Going back to `rpc('get_driver_position')`
    // which the SERVER already returns as plain numbers (latitude /
    // longitude / heading / speed). It's exactly the same data the
    // driver app puts into `useLocationStore` — same source of truth,
    // just delivered through one server hop.
    //
    // Resilience:
    //   - 3s timeout per call (Supabase fetch can hang otherwise)
    //   - Retry on failure with 200/400ms backoff
    //   - Keep last known position on failure (caller's dedup handles it)
    let driverIdCache: string | null = null;
    let consecutiveFailures = 0;
    async function fetchPositionWithRetry(): Promise<{
      latitude: number;
      longitude: number;
      heading: number | null;
      speed: number | null;
      recorded_at: string | null;
    } | null> {
      if (!driverIdCache) {
        try {
          const { data: ride } = await supabase
            .from('rides')
            .select('driver_id')
            .eq('id', rideId)
            .maybeSingle();
          if (!ride?.driver_id) return null;
          driverIdCache = ride.driver_id;
        } catch {
          return null;
        }
      }

      const TIMEOUT_MS = 3_000;
      const callOnce = async () => {
        const rpcPromise = supabase.rpc('get_driver_position', { p_driver_id: driverIdCache });
        const timeoutPromise = new Promise<{ data: null; error: { message: string } }>((resolve) =>
          setTimeout(
            () => resolve({ data: null, error: { message: `timeout after ${TIMEOUT_MS}ms` } }),
            TIMEOUT_MS,
          ),
        );
        return Promise.race([rpcPromise, timeoutPromise]) as Promise<{
          data: unknown;
          error: { message?: string } | null;
        }>;
      };

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await callOnce();
          const error = result?.error;
          const rows = result?.data;
          if (!error && rows) {
            const row = (Array.isArray(rows) ? rows[0] : rows) as {
              latitude?: number;
              longitude?: number;
              heading?: number | null;
              speed?: number | null;
              recorded_at?: string | null;
            } | null;
            if (row && row.latitude != null && row.longitude != null) {
              if (consecutiveFailures > 0) {
                console.log('[useDriverPosition] poll recovered after', consecutiveFailures, 'failures');
              }
              consecutiveFailures = 0;
              return {
                latitude: row.latitude,
                longitude: row.longitude,
                heading: row.heading ?? null,
                speed: row.speed ?? null,
                recorded_at: row.recorded_at ?? null,
              };
            }
            return null;
          }
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          } else {
            consecutiveFailures += 1;
            if (consecutiveFailures === 1 || consecutiveFailures % 5 === 0) {
              console.warn('[useDriverPosition] poll error', {
                message: error?.message ?? 'no data',
                consecutive_failures: consecutiveFailures,
              });
            }
          }
        } catch (err) {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          } else {
            consecutiveFailures += 1;
            if (consecutiveFailures === 1 || consecutiveFailures % 5 === 0) {
              console.warn('[useDriverPosition] poll exception', {
                message: String((err as { message?: string })?.message ?? err),
                consecutive_failures: consecutiveFailures,
              });
            }
          }
        }
      }
      return null;
    }

    let pollSeq = 0;
    const pollInterval = setInterval(async () => {
      pollSeq += 1;
      try {
        const row = await fetchPositionWithRetry();
        if (!row || row.latitude == null || row.longitude == null) {
          // DEBUG-271: log every 5 polls so we know polling is alive even
          // when the RPC has nothing fresh to return.
          if (pollSeq % 5 === 0) {
            console.log('[useDriverPosition] poll #' + pollSeq + ' returned null');
          }
          return;
        }
        const recordedAt = row.recorded_at ? new Date(row.recorded_at).getTime() : Date.now();
        const pos: DriverPosition = {
          latitude: row.latitude,
          longitude: row.longitude,
          heading: row.heading ?? null,
          speed: row.speed ?? null,
          recordedAt,
        };
        hasRealtimeRef.current = true;
        // DEBUG-271: log EVERY poll that returned data so we can see the pipeline
        // working live. Will remove before release.
        console.log('[useDriverPosition] poll #' + pollSeq, {
          lat: pos.latitude.toFixed(5),
          lng: pos.longitude.toFixed(5),
          hdg: pos.heading,
          age_s: Math.round((Date.now() - (recordedAt || Date.now())) / 1000),
        });
        // BUG-271: relaxed dedup — only skip if EXACT same recordedAt timestamp
        // (true duplicate from server). Coordinate-based dedup at 0.000001 was
        // too tight and could block real movement on Cuban networks.
        setState((prev) => {
          if (
            prev.position &&
            prev.position.recordedAt != null &&
            prev.position.recordedAt === recordedAt
          ) {
            return prev; // exact same server sample — no need to re-render
          }
          return { position: pos, isCached: false, cachedAt: null };
        });
        cacheDriverPosition({
          rideId: rideId!,
          latitude: pos.latitude,
          longitude: pos.longitude,
          heading: pos.heading,
          timestamp: Date.now(),
        }).catch(() => {});
      } catch (err) {
        console.warn('[useDriverPosition] poll failed', String(err));
      }
    }, 1_000);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
    };
  }, [rideId]);

  // Clear cache when ride ends (rideId becomes null)
  useEffect(() => {
    return () => {
      if (rideId) {
        clearDriverPositionCache().catch(() => {});
      }
    };
  }, [rideId]);

  return state;
}
