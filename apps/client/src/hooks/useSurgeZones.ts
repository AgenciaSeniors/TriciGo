import { useState, useEffect, useRef } from 'react';
import { rideService } from '@tricigo/api';
import type { SurgeZone } from '@tricigo/types';

const POLL_INTERVAL_MS = 60_000; // 60 seconds

/**
 * Polls active surge zones every 60s.
 * Returns the list of active surges and the highest multiplier.
 */
export function useSurgeZones() {
  const [surges, setSurges] = useState<SurgeZone[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let mounted = true;

    const fetch = async () => {
      try {
        const data = await rideService.getActiveSurges();
        if (mounted) setSurges(data);
      } catch {
        // best-effort, keep previous data
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetch();
    intervalRef.current = setInterval(fetch, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const maxMultiplier = surges.reduce((max, s) => Math.max(max, s.multiplier), 1);
  const hasActiveSurge = surges.length > 0 && maxMultiplier > 1;

  return { surges, maxMultiplier, hasActiveSurge, loading };
}
