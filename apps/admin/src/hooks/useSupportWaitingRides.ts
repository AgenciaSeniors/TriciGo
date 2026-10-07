/**
 * useSupportWaitingRides — the rides waiting for support (admin_support_waiting_rides, 00628),
 * polled every 15 s. Plays the chime when a ride the panel had not seen enters the list, and
 * again when its rider asks for help. Polling rather than Realtime, like useStuckRideAlerts
 * (BUG-277). A failed poll keeps the last list; after FAILURES_BEFORE_NOTICE failures in a row
 * `loadFailed` turns true (the banner says so), and the next successful poll clears it.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { rideAssistService, type SupportWaitingRide } from '@tricigo/api';
import { playChime } from '@/lib/chime';

/** One failed poll is a blip; three in a row (45 s) means support is no longer being told. */
const FAILURES_BEFORE_NOTICE = 3;

export function useSupportWaitingRides(pollMs = 15_000) {
  const [rides, setRides] = useState<SupportWaitingRide[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const seenRef = useRef<Set<string>>(new Set());
  const failuresRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await rideAssistService.getWaitingRides();
      if (!mountedRef.current) return;
      const keys = next.map((r) => `${r.ride_id}:${r.help_requested_at ? 'help' : 'wait'}`);
      const isNew = keys.some((k) => !seenRef.current.has(k));
      seenRef.current = new Set(keys);
      failuresRef.current = 0;
      setLoadFailed(false);
      setRides(next);
      if (isNew) playChime();
    } catch {
      // Keep what is shown; the next poll retries. getWaitingRides already returns [] when the
      // function is not deployed, so anything thrown here is a real failure.
      if (!mountedRef.current) return;
      failuresRef.current += 1;
      if (failuresRef.current >= FAILURES_BEFORE_NOTICE) setLoadFailed(true);
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

  return { rides, loadFailed, refresh: load };
}
