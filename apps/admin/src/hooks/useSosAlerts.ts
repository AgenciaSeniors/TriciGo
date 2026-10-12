/**
 * useSosAlerts — realtime subscription to open SOS incidents.
 *
 * Loads all currently-open critical SOS reports, then subscribes via Supabase
 * Realtime (postgres_changes) to keep the list fresh:
 *   - INSERT of new critical SOS → append to list.
 *   - UPDATE → remove from list once status leaves 'open'.
 *
 * Returns the live list so the dashboard can render a sticky banner.
 *
 * One load and one channel for the whole panel, shared by every component that
 * uses the hook (the header bell and the dashboard banner). Each used to load
 * the list and open its own channel (2026-10-12). The channel closes a moment
 * after the last user unmounts, so moving between pages does not reopen it.
 *
 * Reference: I2 from ride-flow review — admins need to see active SOS
 * without having to navigate to /incidents.
 */
'use client';

import { useSyncExternalStore } from 'react';
import { getSupabaseClient } from '@tricigo/api';
import type { RealtimeChannel } from '@supabase/supabase-js';

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

interface SosState {
  alerts: SosAlert[];
  loading: boolean;
}

const INITIAL: SosState = { alerts: [], loading: true };
const STOP_DELAY_MS = 5_000;

let state: SosState = INITIAL;
const listeners = new Set<() => void>();
let channel: RealtimeChannel | null = null;
let generation = 0;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

function isOpenSos(row: IncidentRow): boolean {
  return row.type === 'sos' && row.severity === 'critical' && row.status === 'open';
}

function toAlert(row: IncidentRow): SosAlert {
  return {
    id: row.id,
    ride_id: row.ride_id,
    reported_by: row.reported_by,
    description: row.description,
    created_at: row.created_at,
  };
}

function setState(next: SosState) {
  state = next;
  for (const listener of listeners) listener();
}

function start() {
  const supabase = getSupabaseClient();
  const current = ++generation;

  void (async () => {
    const { data, error } = await supabase
      .from('incident_reports')
      .select('id, type, severity, status, ride_id, reported_by, description, created_at')
      .eq('type', 'sos')
      .eq('severity', 'critical')
      .eq('status', 'open')
      .order('created_at', { ascending: false });
    if (current !== generation) return;
    if (error || !data) {
      setState({ ...state, loading: false });
      return;
    }
    // Realtime rows that arrived while loading stay; the loaded ones fill in.
    const loaded = (data as IncidentRow[]).map(toAlert);
    const seen = new Set(loaded.map((a) => a.id));
    setState({ alerts: [...state.alerts.filter((a) => !seen.has(a.id)), ...loaded], loading: false });
  })();

  channel = supabase
    .channel('sos-alerts')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'incident_reports' }, (payload) => {
      const row = payload.new as IncidentRow;
      if (!isOpenSos(row) || state.alerts.some((a) => a.id === row.id)) return;
      setState({ ...state, alerts: [toAlert(row), ...state.alerts] });
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'incident_reports' }, (payload) => {
      // If it was an open SOS but isn't anymore, drop it.
      // If it's a newly-matching row we haven't seen, add it (rare).
      const row = payload.new as IncidentRow;
      const exists = state.alerts.some((a) => a.id === row.id);
      if (!isOpenSos(row)) {
        if (exists) setState({ ...state, alerts: state.alerts.filter((a) => a.id !== row.id) });
        return;
      }
      if (!exists) setState({ ...state, alerts: [toAlert(row), ...state.alerts] });
    })
    .subscribe();
}

function stop() {
  generation++;
  if (channel) {
    void getSupabaseClient().removeChannel(channel);
    channel = null;
  }
  state = INITIAL;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  if (!channel) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && !stopTimer) {
      stopTimer = setTimeout(() => {
        stopTimer = null;
        if (listeners.size === 0) stop();
      }, STOP_DELAY_MS);
    }
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL;

export function useSosAlerts() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { alerts: snapshot.alerts, loading: snapshot.loading, count: snapshot.alerts.length };
}
