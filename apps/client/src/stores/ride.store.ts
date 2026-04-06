import { create } from 'zustand';
import * as Notifications from 'expo-notifications';
import i18next from 'i18next';
import type {
  Ride,
  RideWithDriver,
  RideSplit,
  FareEstimate,
  ServiceTypeSlug,
  PaymentMethod,
  RideStatus,
  RidePreferences,
  PackageCategory,
  VehicleType,
  SearchingDriverPresence,
  DriverAcceptedBroadcast,
} from '@tricigo/types';
import type { GeoPoint } from '@tricigo/utils';
import { logger } from '@tricigo/utils';
import { RIDE_CONFIG } from '@/config/ride';

const STATUS_NOTIFICATION_KEYS: Partial<Record<RideStatus, { title: string; body: string }>> = {
  accepted: { title: 'rider:notifications.driver_assigned', body: 'rider:notifications.driver_assigned_body' },
  arrived_at_pickup: { title: 'rider:notifications.driver_arrived', body: 'rider:notifications.driver_arrived_body' },
  completed: { title: 'rider:notifications.trip_completed', body: 'rider:notifications.trip_completed_body' },
};

function scheduleLocalNotification(status: RideStatus) {
  const keys = STATUS_NOTIFICATION_KEYS[status];
  if (!keys) return;
  Notifications.scheduleNotificationAsync({
    content: { title: i18next.t(keys.title), body: i18next.t(keys.body) },
    trigger: null,
  }).catch((err) => { logger.warn('Failed to schedule local notification', { error: String(err) }); });
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

interface DeliveryDraft {
  packageDescription: string;
  recipientName: string;
  recipientPhone: string;
  estimatedWeightKg: string;
  specialInstructions: string;
  packageCategory: PackageCategory | null;
  packageLengthCm: string;
  packageWidthCm: string;
  packageHeightCm: string;
  clientAccompanies: boolean;
  deliveryVehicleType: VehicleType | null;
}

const defaultDelivery: DeliveryDraft = {
  packageDescription: '',
  recipientName: '',
  recipientPhone: '',
  estimatedWeightKg: '',
  specialInstructions: '',
  packageCategory: null,
  packageLengthCm: '',
  packageWidthCm: '',
  packageHeightCm: '',
  clientAccompanies: false,
  deliveryVehicleType: null,
};

interface RideRequestDraft {
  pickup: LocationDraft | null;
  dropoff: LocationDraft | null;
  serviceType: ServiceTypeSlug;
  paymentMethod: PaymentMethod;
  scheduledAt: Date | null;
  delivery: DeliveryDraft;
  waypoints: LocationDraft[];
  corporateAccountId: string | null;
  insuranceSelected: boolean;
  ridePreferences: RidePreferences;
  passengerCount: number;
}

const defaultDraft: RideRequestDraft = {
  pickup: null,
  dropoff: null,
  serviceType: 'triciclo_basico',
  paymentMethod: 'cash',
  scheduledAt: null,
  delivery: { ...defaultDelivery },
  waypoints: [],
  corporateAccountId: null,
  insuranceSelected: false,
  ridePreferences: {},
  passengerCount: 1,
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
  fareEstimatedAt: number | null;
  activeRide: Ride | null;
  rideWithDriver: RideWithDriver | null;
  isLoading: boolean;
  isFareEstimating: boolean;
  error: string | null;

  // Pre-fetched pickup from GPS on app launch
  prefetchedPickup: LocationDraft | null;

  // Promo state
  promoCode: string;
  promoResult: PromoResult | null;

  // Multi-type fare estimates for comparison UI
  allFareEstimates: Partial<Record<ServiceTypeSlug, FareEstimate>> | null;

  // Fare splitting
  splits: RideSplit[];

  // ── Interactive searching state ──
  searchingDrivers: SearchingDriverPresence[];
  acceptedDriverBroadcast: DriverAcceptedBroadcast | null;
  isAcceptAnimating: boolean;

  // ── Rating reminder ──
  ratingReminderId: string | null;

  setFlowStep: (step: RideFlowStep) => void;
  setPickup: (address: string, location: GeoPoint) => void;
  setDropoff: (address: string, location: GeoPoint) => void;
  setServiceType: (type: ServiceTypeSlug) => void;
  setPaymentMethod: (method: PaymentMethod) => void;
  setScheduledAt: (date: Date | null) => void;
  setFareEstimate: (estimate: FareEstimate | null) => void;
  setActiveRide: (ride: Ride | null) => void;
  setRideWithDriver: (ride: RideWithDriver | null) => void;
  updateRideFromRealtime: (ride: Ride) => void;
  setLoading: (loading: boolean) => void;
  setFareEstimating: (v: boolean) => void;
  setError: (error: string | null) => void;
  setPromoCode: (code: string) => void;
  setPromoResult: (result: PromoResult | null) => void;
  setCorporateAccount: (id: string | null) => void;
  setAllFareEstimates: (estimates: Partial<Record<ServiceTypeSlug, FareEstimate>> | null) => void;
  setDeliveryField: (field: keyof DeliveryDraft, value: DeliveryDraft[keyof DeliveryDraft]) => void;
  addWaypoint: () => void;
  removeWaypoint: (index: number) => void;
  updateWaypoint: (index: number, address: string, location: GeoPoint) => void;
  setInsurance: (selected: boolean) => void;
  setPassengerCount: (count: number) => void;
  setRidePreferences: (prefs: RidePreferences) => void;
  setPrefetchedPickup: (pickup: LocationDraft | null) => void;
  swapPickupDropoff: () => void;
  setSplits: (splits: RideSplit[]) => void;
  addSplit: (split: RideSplit) => void;
  removeSplit: (splitId: string) => void;
  updateSplit: (split: RideSplit) => void;
  setSearchingDrivers: (drivers: SearchingDriverPresence[]) => void;
  setAcceptedDriver: (data: DriverAcceptedBroadcast | null) => void;
  setAcceptAnimating: (val: boolean) => void;
  clearSearchState: () => void;
  setRatingReminderId: (id: string | null) => void;
  resetDraft: () => void;
  resetAll: () => void;
}

export const useRideStore = create<RideState>((set, get) => ({
  flowStep: 'idle',
  draft: { ...defaultDraft },
  fareEstimate: null,
  fareEstimatedAt: null,
  activeRide: null,
  rideWithDriver: null,
  isLoading: false,
  isFareEstimating: false,
  error: null,
  prefetchedPickup: null,
  promoCode: '',
  promoResult: null,
  allFareEstimates: null,
  splits: [],
  searchingDrivers: [],
  acceptedDriverBroadcast: null,
  isAcceptAnimating: false,
  ratingReminderId: null,

  setFlowStep: (flowStep) => set({ flowStep }),

  setPickup: (address, location) =>
    set((s) => ({ draft: { ...s.draft, pickup: { address, location } } })),

  setDropoff: (address, location) =>
    set((s) => ({ draft: { ...s.draft, dropoff: { address, location } } })),

  setServiceType: (serviceType) =>
    set((s) => ({ draft: { ...s.draft, serviceType } })),

  setPaymentMethod: (paymentMethod) =>
    set((s) => ({ draft: { ...s.draft, paymentMethod } })),

  setScheduledAt: (scheduledAt) =>
    set((s) => ({ draft: { ...s.draft, scheduledAt } })),

  setFareEstimate: (fareEstimate) => set({ fareEstimate, fareEstimatedAt: fareEstimate ? Date.now() : null }),

  setActiveRide: (activeRide) => set({ activeRide }),

  setRideWithDriver: (rideWithDriver) => set({ rideWithDriver }),

  updateRideFromRealtime: (ride) => {
    const { activeRide } = get();
    if (!activeRide || activeRide.id !== ride.id) return;

    // X2.2: Validate forward-only status transitions
    if (ride.status !== activeRide.status) {
      const STATUS_ORDER = ['searching', 'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'completed', 'canceled'];

      const isValidTransition = (current: string, next: string): boolean => {
        if (next === 'canceled') return true; // can always cancel
        const currentIdx = STATUS_ORDER.indexOf(current);
        const nextIdx = STATUS_ORDER.indexOf(next);
        return nextIdx > currentIdx;
      };

      if (!isValidTransition(activeRide.status, ride.status)) {
        logger.warn('Ignoring invalid ride status transition', {
          rideId: ride.id,
          from: activeRide.status,
          to: ride.status,
        });
        return;
      }

      // Fire local notification on status change
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
  setFareEstimating: (isFareEstimating) => set({ isFareEstimating }),
  setError: (error) => set({ error }),
  setPromoCode: (promoCode) => set({ promoCode }),
  setPromoResult: (promoResult) => set({ promoResult }),
  setAllFareEstimates: (allFareEstimates) => set({ allFareEstimates }),
  setCorporateAccount: (corporateAccountId) =>
    set((s) => ({
      draft: {
        ...s.draft,
        corporateAccountId,
        paymentMethod: corporateAccountId ? 'corporate' : s.draft.paymentMethod === 'corporate' ? 'cash' : s.draft.paymentMethod,
      },
    })),
  setDeliveryField: (field, value) =>
    set((s) => ({ draft: { ...s.draft, delivery: { ...s.draft.delivery, [field]: value } } })),

  addWaypoint: () =>
    set((s) => {
      if (s.draft.waypoints.length >= RIDE_CONFIG.MAX_WAYPOINTS) return s;
      return { draft: { ...s.draft, waypoints: [...s.draft.waypoints, { address: '', location: { latitude: 0, longitude: 0 } }] } };
    }),

  removeWaypoint: (index) =>
    set((s) => ({
      draft: { ...s.draft, waypoints: s.draft.waypoints.filter((_, i) => i !== index) },
    })),

  updateWaypoint: (index, address, location) =>
    set((s) => ({
      draft: {
        ...s.draft,
        waypoints: s.draft.waypoints.map((wp, i) =>
          i === index ? { address, location } : wp
        ),
      },
    })),

  setInsurance: (insuranceSelected) =>
    set((s) => ({ draft: { ...s.draft, insuranceSelected } })),
  setPassengerCount: (passengerCount) =>
    set((s) => ({ draft: { ...s.draft, passengerCount } })),
  setRidePreferences: (ridePreferences) =>
    set((s) => ({ draft: { ...s.draft, ridePreferences } })),
  setPrefetchedPickup: (prefetchedPickup) => set({ prefetchedPickup }),

  swapPickupDropoff: () =>
    set((s) => ({
      draft: { ...s.draft, pickup: s.draft.dropoff, dropoff: s.draft.pickup },
      fareEstimate: null,
      fareEstimatedAt: null,
    })),

  setSplits: (splits) => set({ splits }),
  addSplit: (split) => set((s) => ({ splits: [...s.splits, split] })),
  removeSplit: (splitId) => set((s) => ({ splits: s.splits.filter((sp) => sp.id !== splitId) })),
  updateSplit: (split) => set((s) => ({ splits: s.splits.map((sp) => sp.id === split.id ? { ...sp, ...split } : sp) })),

  setSearchingDrivers: (searchingDrivers) => set({ searchingDrivers }),
  setAcceptedDriver: (acceptedDriverBroadcast) => set({ acceptedDriverBroadcast }),
  setAcceptAnimating: (isAcceptAnimating) => set({ isAcceptAnimating }),
  clearSearchState: () => set({ searchingDrivers: [], acceptedDriverBroadcast: null, isAcceptAnimating: false }),

  setRatingReminderId: (ratingReminderId) => set({ ratingReminderId }),

  resetDraft: () =>
    set({ draft: { ...defaultDraft }, fareEstimate: null, fareEstimatedAt: null, allFareEstimates: null, error: null, promoCode: '', promoResult: null, splits: [], prefetchedPickup: null }),

  resetAll: () => {
    const { ratingReminderId } = get();
    if (ratingReminderId) {
      Notifications.cancelScheduledNotificationAsync(ratingReminderId).catch(() => {});
    }
    set({
      flowStep: 'idle',
      draft: { ...defaultDraft },
      fareEstimate: null,
      fareEstimatedAt: null,
      allFareEstimates: null,
      activeRide: null,
      rideWithDriver: null,
      isLoading: false,
      isFareEstimating: false,
      error: null,
      promoCode: '',
      promoResult: null,
      splits: [],
      prefetchedPickup: null,
      searchingDrivers: [],
      acceptedDriverBroadcast: null,
      isAcceptAnimating: false,
      ratingReminderId: null,
    });
  },
}));
