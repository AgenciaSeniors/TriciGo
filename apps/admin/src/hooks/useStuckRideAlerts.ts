/**
 * useStuckRideAlerts — polls the unresolved rows of `stuck_ride_alerts`
 * (populated by the check_stuck_active_rides() watchdog, migration 00538).
 *
 * Polling (60s) instead of Realtime on purpose: the table changes at most
 * every 5 minutes (the watchdog's cron cadence), and the codebase avoids
 * Realtime channels unless latency demands them (BUG-277).
 *
 * Tolerant of the migration not being applied yet: any error (missing
 * table, RLS) resolves to an empty list — the banner simply never shows.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { getSupabaseClient } from '@tricigo/api';

/**
 * `reason` mirrors the CHECK constraint on `stuck_ride_alerts` — keep the two
 * in step. 'dead_driver_app' was added to the database by 00542 but never
 * here, and the `as StuckRideAlert[]` cast below meant TypeScript never
 * noticed the union had gone stale.
 */
export type StuckRideAlert = {
  ride_id: string;
  reason: 'complete_blocked' | 'stationary_chat' | 'dead_driver_app';
  detected_at: string;
};

export function useStuckRideAlerts(pollMs = 60_000) {
  const [alerts, setAlerts] = useState<StuckRideAlert[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const supabase = getSupabaseClient();

    async function load() {
      try {
        const { data, error } = await supabase
          .from('stuck_ride_alerts')
          .select('ride_id, reason, detected_at')
          .is('resolved_at', null)
          .order('detected_at', { ascending: false });
        if (!mountedRef.current) return;
        if (!error && data) setAlerts(data as StuckRideAlert[]);
      } catch {
        // Migration not applied / transient error → keep whatever we had.
      }
    }

    load();
    const interval = setInterval(load, pollMs);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [pollMs]);

  return { alerts, count: alerts.length };
}
