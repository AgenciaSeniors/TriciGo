import { create } from 'zustand';
import type {
  Ride,
  RideWithDriver,
  FareEstimate,
  ServiceTypeSlug,
  PaymentMethod,
} from '@tricigo/types';
import type { GeoPoint } from '@tricigo/utils';

export type RideFlowStep =
  | 'idle'
  | 'selecting'
  | 'reviewing'
  | 'searching'
  | 'active'
  | 'completed';

interface LocationDraft {
  address: string;
  location: GeoPoint;
}

interface RideRequestDraft {
  pickup: LocationDraft | null;
  dropoff: LocationDraft | null;
  serviceType: ServiceTypeSlug;
  paymentMethod: PaymentMethod;
}

const defaultDraft: RideRequestDraft = {
  pickup: null,
  dropoff: null,
  serviceType: 'triciclo_basico',
  paymentMethod: 'cash',
};

interface RideState {
  flowStep: RideFlowStep;
  draft: RideRequestDraft;
  fareEstimate: FareEstimate | null;
  activeRide: Ride | null;
  rideWithDriver: RideWithDriver | null;
  isLoading: boolean;
  error: string | null;

  setFlowStep: (step: RideFlowStep) => void;
  setPickup: (address: string, location: GeoPoint) => void;
  setDropoff: (address: string, location: GeoPoint) => void;
  setServiceType: (type: ServiceTypeSlug) => void;
  setPaymentMethod: (method: PaymentMethod) => void;
  setFareEstimate: (estimate: FareEstimate | null) => void;
  setActiveRide: (ride: Ride | null) => void;
  setRideWithDriver: (ride: RideWithDriver | null) => void;
  updateRideFromRealtime: (ride: Ride) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  resetDraft: () => void;
  resetAll: () => void;
}

export const useRideStore = create<RideState>((set, get) => ({
  flowStep: 'idle',
  draft: { ...defaultDraft },
  fareEstimate: null,
  activeRide: null,
  rideWithDriver: null,
  isLoading: false,
  error: null,

  setFlowStep: (flowStep) => set({ flowStep }),

  setPickup: (address, location) =>
    set((s) => ({ draft: { ...s.draft, pickup: { address, location } } })),

  setDropoff: (address, location) =>
    set((s) => ({ draft: { ...s.draft, dropoff: { address, location } } })),

  setServiceType: (serviceType) =>
    set((s) => ({ draft: { ...s.draft, serviceType } })),

  setPaymentMethod: (paymentMethod) =>
    set((s) => ({ draft: { ...s.draft, paymentMethod } })),

  setFareEstimate: (fareEstimate) => set({ fareEstimate }),

  setActiveRide: (activeRide) => set({ activeRide }),

  setRideWithDriver: (rideWithDriver) => set({ rideWithDriver }),

  updateRideFromRealtime: (ride) => {
    const { activeRide } = get();
    if (!activeRide || activeRide.id !== ride.id) return;

    set({ activeRide: ride });

    // Advance flowStep based on status
    if (ride.status === 'searching') {
      set({ flowStep: 'searching' });
    } else if (
      ride.status === 'accepted' ||
      ride.status === 'driver_en_route' ||
      ride.status === 'arrived_at_pickup' ||
      ride.status === 'in_progress'
    ) {
      set({ flowStep: 'active' });
    } else if (ride.status === 'completed') {
      set({ flowStep: 'completed' });
    } else if (ride.status === 'canceled') {
      set({ flowStep: 'idle', activeRide: null, rideWithDriver: null, error: null });
    }
  },

  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),

  resetDraft: () =>
    set({ draft: { ...defaultDraft }, fareEstimate: null, error: null }),

  resetAll: () =>
    set({
      flowStep: 'idle',
      draft: { ...defaultDraft },
      fareEstimate: null,
      activeRide: null,
      rideWithDriver: null,
      isLoading: false,
      error: null,
    }),
}));
