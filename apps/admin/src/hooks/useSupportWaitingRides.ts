/**
 * useSupportWaitingRides — the rides waiting for support (admin_support_waiting_rides, 00628),
 * polled every 15 s. Plays the chime when a ride the panel had not seen enters the list, and
 * again when its rider asks for help. Polling rather than Realtime, like useStuckRideAlerts
 * (BUG-277). A failed poll keeps the last list.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { rideAssistService, type SupportWaitingRide } from '@tricigo/api';
import { playChime } from '@/lib/chime';

export function useSupportWaitingRides(pollMs = 15_000) {
  const [rides, setRides] = useState<SupportWaitingRide[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await rideAssistService.getWaitingRides();
      if (!mountedRef.current) return;
      const keys = next.map((r) => `${r.ride_id}:${r.help_requested_at ? 'help' : 'wait'}`);
      const isNew = keys.some((k) => !seenRef.current.has(k));
      seenRef.current = new Set(keys);
      setRides(next);
      if (isNew) playChime();
    } catch {
      // Keep what is shown; the next poll retries.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const id = setInterval(load, pollMs);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [load, pollMs]);

  return { rides, refresh: load };
}
