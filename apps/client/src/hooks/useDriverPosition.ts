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

  // Realtime subscription
  useEffect(() => {
    if (!rideId) return;

    const supabase = getSupabaseClient();
    const channel = supabase
      .channel(`driver-pos:${rideId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'ride_location_events',
          filter: `ride_id=eq.${rideId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          // Parse location from POINT string if needed
          if (typeof row.location === 'string') {
            const match = (row.location as string).match(/POINT\(([^ ]+) ([^ ]+)\)/);
            if (match && match[1] && match[2]) {
              const pos: DriverPosition = {
                latitude: parseFloat(match[2]!),
                longitude: parseFloat(match[1]!),
                heading: (row.heading as number) ?? null,
              };
              hasRealtimeRef.current = true;
              setState({
                position: pos,
                isCached: false,
                cachedAt: null,
              });

              // Cache the fresh position for offline resilience
              cacheDriverPosition({
                rideId: rideId!,
                latitude: pos.latitude,
                longitude: pos.longitude,
                heading: pos.heading,
                timestamp: Date.now(),
              }).catch(() => { /* best effort */ });
            }
          }
        },
      )
      .subscribe();

    return () => {
      channel.unsubscribe();
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
