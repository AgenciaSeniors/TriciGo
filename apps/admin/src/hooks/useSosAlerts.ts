/**
 * useSosAlerts — realtime subscription to open SOS incidents.
 *
 * Loads all currently-open critical SOS reports on mount, then subscribes
 * via Supabase Realtime (postgres_changes) to keep the list fresh:
 *   - INSERT of new critical SOS → append to list.
 *   - UPDATE → remove from list once status leaves 'open'.
 *
 * Returns the live list so the dashboard can render a sticky banner.
 *
 * Reference: I2 from ride-flow review — admins need to see active SOS
 * without having to navigate to /incidents.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { getSupabaseClient } from '@tricigo/api';

export type SosAlert = {
  id: string;
  ride_id: string | null;
  reported_by: string;
  description: string;
  created_at: string;
};

type IncidentRow = {
  id: string;
  type: string;
  severity: string;
  status: string;
  ride_id: string | null;
  reported_by: string;
  description: string;
  created_at: string;
};

function isOpenSos(row: IncidentRow): boolean {
  return row.type === 'sos' && row.severity === 'critical' && row.status === 'open';
}

export function useSosAlerts() {
  const [alerts, setAlerts] = useState<SosAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const supabase = getSupabaseClient();

    async function loadInitial() {
      const { data, error } = await supabase
        .from('incident_reports')
        .select('id, type, severity, status, ride_id, reported_by, description, created_at')
        .eq('type', 'sos')
        .eq('severity', 'critical')
        .eq('status', 'open')
        .order('created_at', { ascending: false });

      if (!mountedRef.current) return;
      if (!error && data) {
        setAlerts(
          data.map((row) => ({
            id: row.id,
            ride_id: row.ride_id,
            reported_by: row.reported_by,
            description: row.description,
            created_at: row.created_at,
          })),
        );
      }
      setLoading(false);
    }

    loadInitial();

    const channel = supabase
      .channel('sos-alerts')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'incident_reports' },
        (payload) => {
          const row = payload.new as IncidentRow;
          if (!isOpenSos(row)) return;
          setAlerts((prev) =>
            prev.some((a) => a.id === row.id)
              ? prev
              : [
                  {
                    id: row.id,
                    ride_id: row.ride_id,
                    reported_by: row.reported_by,
                    description: row.description,
                    created_at: row.created_at,
                  },
                  ...prev,
                ],
          );
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'incident_reports' },
        (payload) => {
          const row = payload.new as IncidentRow;
          // If it was an open SOS but isn't anymore, drop it.
          // If it's a newly-matching row we haven't seen, add it (rare).
          setAlerts((prev) => {
            const exists = prev.some((a) => a.id === row.id);
            if (!isOpenSos(row)) {
              return exists ? prev.filter((a) => a.id !== row.id) : prev;
            }
            if (exists) return prev;
            return [
              {
                id: row.id,
                ride_id: row.ride_id,
                reported_by: row.reported_by,
                description: row.description,
                created_at: row.created_at,
              },
              ...prev,
            ];
          });
        },
      )
      .subscribe();

    return () => {
      mountedRef.current = false;
      supabase.removeChannel(channel);
    };
  }, []);

  return { alerts, loading, count: alerts.length };
}
