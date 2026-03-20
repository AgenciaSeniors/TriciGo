import { create } from 'zustand';
import * as Notifications from 'expo-notifications';
import type { Ride } from '@tricigo/types';

/** Ride with a local timestamp for TTL expiry */
type TimestampedRide = Ride & { _receivedAt: number };

interface DriverRideState {
  incomingRequests: TimestampedRide[];
  activeTrip: Ride | null;

  addRequest: (ride: Ride) => void;
  removeRequest: (rideId: string) => void;
  removeStaleRequests: () => void;
  clearRequests: () => void;
  setActiveTrip: (trip: Ride | null) => void;
  updateActiveTrip: (trip: Ride) => void;
  reset: () => void;
}

export const useDriverRideStore = create<DriverRideState>((set, get) => ({
  incomingRequests: [],
  activeTrip: null,

  addRequest: (ride) =>
    set((s) => {
      // Avoid duplicates
      if (s.incomingRequests.some((r) => r.id === ride.id)) return s;
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

  /** Remove requests older than 90 seconds */
  removeStaleRequests: () =>
    set((s) => {
      const now = Date.now();
      const fresh = s.incomingRequests.filter((r) => now - r._receivedAt < 90_000);
      if (fresh.length === s.incomingRequests.length) return s;
      return { incomingRequests: fresh };
    }),

  clearRequests: () => set({ incomingRequests: [] }),

  setActiveTrip: (activeTrip) => set({ activeTrip }),

  updateActiveTrip: (trip) => {
    const { activeTrip } = get();
    if (!activeTrip || activeTrip.id !== trip.id) return;
    set({ activeTrip: trip });
  },

  reset: () => set({ incomingRequests: [], activeTrip: null }),
}));
