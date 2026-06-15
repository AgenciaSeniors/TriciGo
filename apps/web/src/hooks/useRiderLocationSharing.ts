'use client';

import { useEffect, useRef } from 'react';
import { getSupabaseClient } from '@tricigo/api';
import type { RealtimeChannel } from '@supabase/supabase-js';

/**
 * Web port of the mobile client's `useRiderLocationSharing`. Broadcasts the
 * rider's location on `rider-location:${rideId}` (event `rider_location`)
 * during the pickup phase so the driver app can show the rider's pin. Uses
 * `navigator.geolocation.watchPosition` with manual throttling (≥50m or ≥15s)
 * to mirror the native distanceInterval/timeInterval.
 */
const PICKUP_STATUSES = ['searching', 'accepted', 'driver_en_route', 'arrived_at_pickup'];

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function useRiderLocationSharing(
  rideId: string | null | undefined,
  rideStatus: string | null | undefined,
  userId: string | null | undefined,
) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const lastSentRef = useRef<{ lat: number; lng: number; at: number } | null>(null);

  useEffect(() => {
    const shouldShare =
      !!rideId && !!userId && !!rideStatus && PICKUP_STATUSES.includes(rideStatus) &&
      typeof navigator !== 'undefined' && !!navigator.geolocation;

    if (!shouldShare) {
      if (channelRef.current) { channelRef.current.unsubscribe(); channelRef.current = null; }
      lastSentRef.current = null;
      return;
    }

    const supabase = getSupabaseClient();
    // RT-01 (audit round 6): PRIVATE channel — only the ride's customer +
    // assigned driver may join (RLS on realtime.messages via is_ride_party).
    const channel = supabase.channel(`rider-location:${rideId}`, {
      config: { private: true },
    });
    // Attach the user JWT to the realtime socket, then subscribe so the
    // realtime.messages policy can authorize this private topic.
    supabase.realtime
      .setAuth()
      .then(() => channel.subscribe())
      .catch(() => { /* best-effort */ });
    channelRef.current = channel;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const now = Date.now();
        const last = lastSentRef.current;
        // Throttle: send only if moved ≥50m or ≥15s elapsed.
        if (last && now - last.at < 15000 && haversineM(last.lat, last.lng, latitude, longitude) < 50) return;
        lastSentRef.current = { lat: latitude, lng: longitude, at: now };
        channelRef.current?.send({
          type: 'broadcast',
          event: 'rider_location',
          payload: { user_id: userId, latitude, longitude, timestamp: now },
        });
      },
      () => { /* permission denied / unavailable — best-effort */ },
      { enableHighAccuracy: false, maximumAge: 10000, timeout: 20000 },
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
      if (channelRef.current) { channelRef.current.unsubscribe(); channelRef.current = null; }
      lastSentRef.current = null;
    };
  }, [rideId, rideStatus, userId]);
}
