import { create } from 'zustand';
import * as Notifications from 'expo-notifications';
import type { Ride } from '@tricigo/types';
import { logger } from '@tricigo/utils';

/** Ride with a local timestamp for TTL expiry */
type TimestampedRide = Ride & { _receivedAt: number };

interface DriverRideState {
  incomingRequests: TimestampedRide[];
  /** Ride ids the driver explicitly refused this session (see dismissRequest). */
  dismissedRequestIds: string[];
  activeTrip: Ride | null;
  isAdvancing: boolean;
  isDriverCanceling: boolean;

  addRequest: (ride: Ride) => void;
  removeRequest: (rideId: string) => void;
  /** Explicit refusal — also remembered so the poll cannot re-add it. */
  dismissRequest: (rideId: string) => void;
  removeStaleRequests: () => void;
  clearRequests: () => void;
  setActiveTrip: (trip: Ride | null) => void;
  updateActiveTrip: (trip: Ride) => void;
  setIsAdvancing: (v: boolean) => void;
  setDriverCanceling: (v: boolean) => void;
  reset: () => void;
}

export const useDriverRideStore = create<DriverRideState>((set, get) => ({
  incomingRequests: [],
  /** Offers the driver explicitly turned down this session. */
  dismissedRequestIds: [],
  activeTrip: null,
  isAdvancing: false,
  isDriverCanceling: false,

  addRequest: (ride) =>
    set((s) => {
      // Avoid duplicates
      if (s.incomingRequests.some((r) => r.id === ride.id)) return s;
      // …and don't resurrect one the driver just turned down. `addRequest`
      // only ever checked the CURRENT list, which "No me sirve" had just
      // removed from — so the 30s `getSearchingRides` poll re-added the very
      // offer they declined, reopened the full-screen card, and fired another
      // "Nueva solicitud de viaje" notification for it. There is no
      // server-side decline to lean on (ride_offers is REVOKEd from
      // `authenticated` and no decline RPC exists), so the refusal has to be
      // remembered here until the offer expires on its own.
      if (s.dismissedRequestIds.includes(ride.id)) return s;
      // Local notification for new ride request
      Notifications.scheduleNotificationAsync({
        content: {
          title: 'TriciGo',
          body: 'Nueva solicitud de viaje',
        },
        trigger: null,
      }).catch(() => { /* best-effort: local notification */ });
      return { incomingRequests: [{ ...ride, _receivedAt: Date.now() }, ...s.incomingRequests] };
    }),

  removeRequest: (rideId) =>
    set((s) => ({
      incomingRequests: s.incomingRequests.filter((r) => r.id !== rideId),
    })),

  // Explicit "No me sirve". Kept separate from `removeRequest` (which also
  // runs for expiry and for accept) so only a deliberate refusal is
  // remembered. Capped so a long shift cannot grow it without bound; offers
  // live 30s, so anything past the recent few is already irrelevant.
  dismissRequest: (rideId) =>
    set((s) => ({
      incomingRequests: s.incomingRequests.filter((r) => r.id !== rideId),
      dismissedRequestIds: [rideId, ...s.dismissedRequestIds.filter((id) => id !== rideId)].slice(0, 50),
    })),

  /**
   * Remove expired requests.
   *
   * Prefers the server-issued `offer_expires_at` (ride_offers.expires_at)
   * when present — this is the authoritative expiry for the offer window.
   * Falls back to a 30s TTL on `_receivedAt` for rides created before
   * the ride_offers migration or when the field is missing.
   */
  removeStaleRequests: () =>
    set((s) => {
      const now = Date.now();
      const fresh = s.incomingRequests.filter((r) => {
        if (r.offer_expires_at) {
          return new Date(r.offer_expires_at).getTime() > now;
        }
        return now - r._receivedAt < 30_000;
      });
      if (fresh.length === s.incomingRequests.length) return s;
      return { incomingRequests: fresh };
    }),

  clearRequests: () => set({ incomingRequests: [] }),

  setIsAdvancing: (v) => set({ isAdvancing: v }),

  setDriverCanceling: (v) => set({ isDriverCanceling: v }),

  setActiveTrip: (activeTrip) => set({ activeTrip }),

  updateActiveTrip: (trip) => {
    const { activeTrip } = get();
    if (!activeTrip || activeTrip.id !== trip.id) return;
    // BUG-262: stale-update guard with status forward-progress override.
    //
    // Original guard: ignore any realtime payload whose `updated_at` is
    // older than the local one. Problem: realtime delivery can arrive
    // out-of-order (replication lag, retry, multi-tab) and a *legitimate*
    // status change (e.g. arrived → in_progress) might carry an
    // updated_at slightly older than the local row that received an
    // unrelated touch from a trigger. NTP drift between server and
    // device adds up to ~2 s of false negatives.
    //
    // New rule: keep the timestamp guard but ALWAYS accept the payload
    // when (a) it's a status forward transition or (b) the timestamp
    // delta is within a 2-second tolerance window (NTP drift).
    if (activeTrip && trip.updated_at && activeTrip.updated_at) {
      const localTime = new Date(activeTrip.updated_at).getTime();
      const recvTime  = new Date(trip.updated_at).getTime();
      const driftMs   = localTime - recvTime;
      // Forward status transitions always win (immune to clock skew).
      // 'disputed' at the end: a `completed → disputed` update (once
      // formal_disputes_enabled is on; valid_transitions added the edge in
      // 00409) must count as forward so it isn't ignored as a stale update.
      const STATUS_ORDER = [
        'searching','accepted','driver_en_route','arrived_at_pickup',
        'in_progress','arrived_at_destination','completed','disputed',
      ];
      const localIdx = STATUS_ORDER.indexOf(activeTrip.status);
      const recvIdx  = STATUS_ORDER.indexOf(trip.status);
      const isForward = recvIdx > localIdx || trip.status === 'canceled';
      const NTP_TOLERANCE_MS = 2_000;
      if (driftMs > NTP_TOLERANCE_MS && !isForward) {
        logger.warn('[Realtime] Stale update ignored', {
          ride_id: trip.id,
          local_updated: activeTrip.updated_at,
          received_updated: trip.updated_at,
          drift_ms: driftMs,
        });
        return;
      }
    }
    set({ activeTrip: trip });
  },

  reset: () => set({ incomingRequests: [], activeTrip: null, isAdvancing: false, isDriverCanceling: false }),
}));
