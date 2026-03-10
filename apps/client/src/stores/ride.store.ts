import { create } from 'zustand';
import * as Notifications from 'expo-notifications';
import type {
  Ride,
  RideWithDriver,
  FareEstimate,
  ServiceTypeSlug,
  PaymentMethod,
  RideStatus,
} from '@tricigo/types';
import type { GeoPoint } from '@tricigo/utils';

const STATUS_NOTIFICATIONS: Partial<Record<RideStatus, string>> = {
  accepted: 'Conductor asignado',
  driver_en_route: 'Conductor en camino',
  arrived_at_pickup: 'Conductor llegó al punto de recogida',
  completed: 'Viaje completado',
};

function scheduleLocalNotification(status: RideStatus) {
  const body = STATUS_NOTIFICATIONS[status];
  if (!body) return;
  Notifications.scheduleNotificationAsync({
    content: { title: 'TriciGo', body },
    trigger: null,
  }).catch(() => { /* best-effort: local notification */ });
}

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

interface PromoResult {
  valid: boolean;
  discountAmount: number;
  promotionId?: string;
  error?: string;
}

interface RideState {
  flowStep: RideFlowStep;
  draft: RideRequestDraft;
  fareEstimate: FareEstimate | null;
  activeRide: Ride | null;
  rideWithDriver: RideWithDriver | null;
  isLoading: boolean;
  error: string | null;

  // Promo state
  promoCode: string;
  promoResult: PromoResult | null;

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
  setPromoCode: (code: string) => void;
  setPromoResult: (result: PromoResult | null) => void;
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
  promoCode: '',
  promoResult: null,

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

    // Fire local notification on status change
    if (ride.status !== activeRide.status) {
      scheduleLocalNotification(ride.status);
    }

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
  setPromoCode: (promoCode) => set({ promoCode }),
  setPromoResult: (promoResult) => set({ promoResult }),

  resetDraft: () =>
    set({ draft: { ...defaultDraft }, fareEstimate: null, error: null, promoCode: '', promoResult: null }),

  resetAll: () =>
    set({
      flowStep: 'idle',
      draft: { ...defaultDraft },
      fareEstimate: null,
      activeRide: null,
      rideWithDriver: null,
      isLoading: false,
      error: null,
      promoCode: '',
      promoResult: null,
    }),
}));
