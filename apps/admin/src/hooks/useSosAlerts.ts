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
 * the list and open its own channel (2026-10-12). The list is read when the
 * channel goes live and again after every reconnection, so an SOS created while
 * the link was down still shows. The channel closes a moment after the last
 * user unmounts, so moving between pages does not reopen it.
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
const RETRY_MS = 30_000;

let state: SosState = INITIAL;
const listeners = new Set<() => void>();
let channel: RealtimeChannel | null = null;
let generation = 0;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Realtime rows that arrived while a load was in flight, applied on top of its result. */
let arrivedDuringLoad: Map<string, IncidentRow> | null = null;
let loadAgain = false;

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

/** An insert or update: open SOS rows go to the top, any other row leaves the list. */
function withRow(alerts: SosAlert[], row: IncidentRow): SosAlert[] {
  const rest = alerts.filter((a) => a.id !== row.id);
  return isOpenSos(row) ? [toAlert(row), ...rest] : rest;
}

function applyRow(row: IncidentRow) {
  if (arrivedDuringLoad) arrivedDuringLoad.set(row.id, row);
  const exists = state.alerts.some((a) => a.id === row.id);
  if (!isOpenSos(row) && !exists) return;
  if (isOpenSos(row) && exists) return;
  setState({ ...state, alerts: withRow(state.alerts, row) });
}

/**
 * The open SOS list, read from the database. It runs right away, when the
 * channel becomes live (catching what happened before it was), and again on
 * every rejoin after a dropped connection: realtime does not replay the events
 * of the gap (an admin's link drops for two minutes, an SOS is created in
 * between). A failed load retries.
 */
async function load(current: number) {
  if (arrivedDuringLoad) {
    loadAgain = true;
    return;
  }
  arrivedDuringLoad = new Map();
  const { data, error } = await getSupabaseClient()
    .from('incident_reports')
    .select('id, type, severity, status, ride_id, reported_by, description, created_at')
    .eq('type', 'sos')
    .eq('severity', 'critical')
    .eq('status', 'open')
    .order('created_at', { ascending: false });
  const arrived = arrivedDuringLoad;
  arrivedDuringLoad = null;
  if (current !== generation) return;

  if (error || !data) {
    setState({ ...state, loading: false });
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (current === generation) void load(current);
      }, RETRY_MS);
    }
  } else {
    let alerts = (data as IncidentRow[]).map(toAlert);
    for (const row of arrived.values()) alerts = withRow(alerts, row);
    setState({ alerts, loading: false });
  }

  if (loadAgain) {
    loadAgain = false;
    void load(current);
  }
}

function start() {
  const supabase = getSupabaseClient();
  const current = ++generation;

  // One topic per start: a channel still closing from the last stop keeps its own.
  channel = supabase
    .channel(`sos-alerts-${current}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'incident_reports' }, (payload) => {
      applyRow(payload.new as IncidentRow);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'incident_reports' }, (payload) => {
      applyRow(payload.new as IncidentRow);
    })
    .subscribe((status) => {
      if (current === generation && status === 'SUBSCRIBED') void load(current);
    });

  void load(current);
}

function stop() {
  generation++;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  loadAgain = false;
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
