'use client';

import { useEffect, useRef, useState } from 'react';
import { getSupabaseClient } from '@tricigo/api';

export interface DriverPosition {
  latitude: number;
  longitude: number;
  heading: number | null;
  speed: number | null;
  /** Wall-clock ms of the GPS fix (server side). */
  recordedAt: number;
}

export interface DriverPositionState {
  position: DriverPosition | null;
  /** ms timestamp of the last poll that returned data. */
  lastSampleAt: number | null;
  /** No fresh sample for > STALE_MS. */
  isStale: boolean;
}

const POLL_MS = 1000;
const STALE_MS = 30_000;
const TIMEOUT_MS = 3_000;

/**
 * Web port of the mobile client's `useDriverPosition` (BUG-277 polling-only
 * architecture). Polls the `get_driver_position` RPC at 1 Hz — the SAME source
 * of truth the driver app writes via `update_driver_position`. Replaces the
 * dead `driver-location-${driverId}` broadcast channel the web used to listen
 * on (the GPS loop no longer emits it), which is why the driver marker never
 * moved on the authenticated tracking page.
 */
export function useDriverPosition(driverId: string | null | undefined, active: boolean): DriverPositionState {
  const [position, setPosition] = useState<DriverPosition | null>(null);
  const [lastSampleAt, setLastSampleAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const recordedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!driverId || !active) {
      setPosition(null);
      setLastSampleAt(null);
      recordedAtRef.current = null;
      return;
    }
    const supabase = getSupabaseClient();
    let cancelled = false;

    async function fetchWithRetry() {
      const callOnce = () => {
        const rpc = supabase.rpc('get_driver_position', { p_driver_id: driverId });
        const timeout = new Promise<{ data: null; error: { message: string } }>((resolve) =>
          setTimeout(() => resolve({ data: null, error: { message: `timeout ${TIMEOUT_MS}ms` } }), TIMEOUT_MS),
        );
        return Promise.race([rpc, timeout]) as Promise<{ data: unknown; error: { message?: string } | null }>;
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await callOnce();
          if (!result?.error && result?.data) {
            const rows = result.data;
            const row = (Array.isArray(rows) ? rows[0] : rows) as {
              latitude?: number; longitude?: number; heading?: number | null;
              speed?: number | null; recorded_at?: string | null;
            } | null;
            if (row && row.latitude != null && row.longitude != null) {
              return {
                latitude: row.latitude,
                longitude: row.longitude,
                heading: row.heading ?? null,
                speed: row.speed ?? null,
                recordedAt: row.recorded_at ? new Date(row.recorded_at).getTime() : Date.now(),
              } as DriverPosition;
            }
            return null;
          }
          if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        } catch {
          if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        }
      }
      return null;
    }

    const poll = async () => {
      const pos = await fetchWithRetry();
      if (cancelled || !pos) return;
      // Relaxed dedup — skip only true duplicates (same server timestamp).
      if (recordedAtRef.current === pos.recordedAt) {
        setLastSampleAt(Date.now());
        return;
      }
      recordedAtRef.current = pos.recordedAt;
      setPosition(pos);
      setLastSampleAt(Date.now());
    };

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [driverId, active]);

  // Lightweight ticker so `isStale` recomputes without a fresh sample.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [active]);

  const isStale = lastSampleAt != null && now - lastSampleAt > STALE_MS;
  return { position, lastSampleAt, isStale };
}
