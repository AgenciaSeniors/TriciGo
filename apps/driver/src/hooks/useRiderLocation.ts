import { useEffect, useRef, useState } from 'react';
import { getSupabaseClient } from '@tricigo/api';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface RiderLocationPayload {
  user_id: string;
  latitude: number;
  longitude: number;
  timestamp: number;
}

interface RiderLocation {
  latitude: number;
  longitude: number;
}

/**
 * Subscribes to the rider's real-time location during the pickup phase.
 * The client app broadcasts its position via the `rider-location:{rideId}`
 * Supabase Realtime broadcast channel (see apps/client useRiderLocationSharing).
 *
 * Only active when `enabled` is true (caller should pass true only during
 * pickup phases: status === 'accepted' or 'driver_en_route').
 *
 * @returns The latest rider location, or null if not yet received.
 */
export function useRiderLocation(
  rideId: string | undefined | null,
  enabled: boolean,
): RiderLocation | null {
  const [riderLocation, setRiderLocation] = useState<RiderLocation | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    // Clean up previous location when ride changes
    setRiderLocation(null);

    if (!rideId || !enabled) {
      // Cleanup channel if no longer needed
      if (channelRef.current) {
        channelRef.current.unsubscribe();
        channelRef.current = null;
      }
      return;
    }

    const supabase = getSupabaseClient();
    const channel = supabase.channel(`rider-location:${rideId}`);

    channel
      .on('broadcast', { event: 'rider_location' }, ({ payload }) => {
        const data = payload as RiderLocationPayload;
        if (data.latitude && data.longitude) {
          setRiderLocation({
            latitude: data.latitude,
            longitude: data.longitude,
          });
        }
      })
      .subscribe();

    channelRef.current = channel;

    return () => {
      channel.unsubscribe();
      channelRef.current = null;
    };
  }, [rideId, enabled]);

  return riderLocation;
}
