import { useEffect, useRef } from 'react';
import * as Location from 'expo-location';
import { getSupabaseClient } from '@tricigo/api';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';

/**
 * Shares the rider's location via Supabase Realtime broadcast during
 * the pickup phase of a ride. The driver app subscribes to this channel
 * to show the rider's pin on the map.
 *
 * Active when: flowStep is 'searching', 'active' AND ride status is
 * 'accepted' or 'arrived_at_pickup' (i.e., driver is coming to pick up).
 *
 * Stops when: ride moves to 'in_progress', 'completed', 'canceled', or idle.
 */
export function useRiderLocationSharing() {
  const userId = useAuthStore((s) => s.user?.id);
  const activeRide = useRideStore((s) => s.activeRide);
  const flowStep = useRideStore((s) => s.flowStep);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    const rideId = activeRide?.id;
    const rideStatus = activeRide?.status;

    // Only share location during pickup phase
    const shouldShare =
      !!rideId &&
      !!userId &&
      (flowStep === 'searching' || flowStep === 'active') &&
      (rideStatus === 'searching' || rideStatus === 'accepted' || rideStatus === 'arrived_at_pickup');

    if (!shouldShare) {
      // Cleanup
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
      if (channelRef.current) {
        channelRef.current.unsubscribe();
        channelRef.current = null;
      }
      return;
    }

    let cancelled = false;

    async function startSharing() {
      try {
        // Check location permissions (should already be granted from address search)
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted') return;

        // Create a broadcast channel for this ride
        const supabase = getSupabaseClient();
        channelRef.current = supabase.channel(`rider-location:${rideId}`);
        channelRef.current.subscribe();

        // Watch position with lower accuracy and less frequent updates
        // (rider location is supplementary, not primary tracking)
        subscriptionRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            distanceInterval: 50, // 50m minimum movement
            timeInterval: 15000, // every 15 seconds
          },
          (loc) => {
            if (cancelled || !channelRef.current) return;

            // Broadcast rider location to the channel
            channelRef.current.send({
              type: 'broadcast',
              event: 'rider_location',
              payload: {
                user_id: userId,
                latitude: loc.coords.latitude,
                longitude: loc.coords.longitude,
                timestamp: Date.now(),
              },
            });
          },
        );
      } catch {
        // Silent — rider location sharing is best-effort
      }
    }

    startSharing();

    return () => {
      cancelled = true;
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
      if (channelRef.current) {
        channelRef.current.unsubscribe();
        channelRef.current = null;
      }
    };
  }, [userId, activeRide?.id, activeRide?.status, flowStep]);
}
