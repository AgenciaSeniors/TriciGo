import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
import { logger, deliveryVehicleToSlug } from '@tricigo/utils';
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

interface WaypointDraft {
  address: string;
  location: GeoPoint | null;
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
  // Mensajería: vehículo por defecto = moto (como la web) → la tarjeta muestra
  // el precio al instante; el rider puede cambiar a triciclo/auto. Solo se usa
  // en mensajería (en viajes de pasajero deliveryVehicleType se ignora).
  deliveryVehicleType: 'moto',
};

interface RideRequestDraft {
  pickup: LocationDraft | null;
  dropoff: LocationDraft | null;
  serviceType: ServiceTypeSlug;
  paymentMethod: PaymentMethod;
  scheduledAt: Date | null;
  delivery: DeliveryDraft;
  waypoints: WaypointDraft[];
  corporateAccountId: string | null;
  insuranceSelected: boolean;
  ridePreferences: RidePreferences;
  passengerCount: number;
  /** "Compartir viaje": rider lets the driver fill empty seats (triciclo only). */
  shareRide: boolean;
  walletRatio: number;
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
  shareRide: false,
  walletRatio: 0.5,
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
  setShareRide: (shareRide: boolean) => void;
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
  setWalletRatio: (ratio: number) => void;
  setRatingReminderId: (id: string | null) => void;
  resetServiceSelection: () => void;
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

  // BUG-253 (Capa 3.4): refuse to mutate pickup/dropoff while a ride is
  // pinned. The user must explicitly cancel the active ride first via
  // cancelRide(). Without this guard, the local draft and the DB row
  // diverged ("phantom ride" — vehicle picker locked, address mismatch).
  setPickup: (address, location) =>
    set((s) => {
      if (s.activeRide) {
        logger.warn('[ride.store] setPickup ignored — activeRide is pinned', {
          rideId: s.activeRide.id,
          status: s.activeRide.status,
        });
        return s;
      }
      // Bug (verificado 2026-06-04, ride 6b61d130): clear the fare estimate
      // when pickup changes so a stale estimate (from a previous location)
      // can't be persisted by confirmRide. The TTL guard keys on
      // fareEstimatedAt; nulling it forces a fresh requestEstimate before the
      // ride can be confirmed. Mirrors swapPickupDropoff / addWaypoint.
      return { draft: { ...s.draft, pickup: { address, location } }, fareEstimate: null, fareEstimatedAt: null };
    }),

  setDropoff: (address, location) =>
    set((s) => {
      if (s.activeRide) {
        logger.warn('[ride.store] setDropoff ignored — activeRide is pinned', {
          rideId: s.activeRide.id,
          status: s.activeRide.status,
        });
        return s;
      }
      // Bug (verificado 2026-06-04): see setPickup — clear the stale estimate
      // on dropoff change so confirmRide can't persist a fare from the
      // previous destination. Root cause of estimated_fare_cup (e.g. 2200,
      // far destination) not matching estimated_distance_m (near destination).
      return { draft: { ...s.draft, dropoff: { address, location } }, fareEstimate: null, fareEstimatedAt: null };
    }),

  setServiceType: (serviceType) =>
    set((s) => {
      // BUG-213 (Issue A post-v1.1.14): when the user picks a different
      // vehicle, also swap `fareEstimate` (singular) to the matching
      // entry in `allFareEstimates`. Without this, requestRide read a
      // stale `fareEstimate` (from the previous service_type, usually
      // the default Triciclo) and persisted Triciclo's
      // estimated_fare_cup / estimated_duration_s on a ride whose
      // service_type was Auto. The driver app then re-rendered using
      // the Triciclo-shaped duration with Auto rates, producing a third
      // value that matched neither client card.
      //
      // Only swap if `allFareEstimates[serviceType]` is populated. If
      // the background fetch hasn't filled that slot yet, we leave
      // `fareEstimate` alone — the next `requestEstimate` call will
      // populate it normally for the now-current service_type.
      // Mensajería se cobra al precio del VEHÍCULO elegido: el fareEstimate
      // singular (label del botón "Solicitar", ETA, prechecks mixed/corporate)
      // debe ser el del vehículo, no el config plano de 'mensajeria'.
      const effSlug =
        serviceType === 'mensajeria' && s.draft.delivery.deliveryVehicleType
          ? deliveryVehicleToSlug(s.draft.delivery.deliveryVehicleType)
          : serviceType;
      const candidate = s.allFareEstimates?.[effSlug] ?? null;
      if (candidate) {
        return {
          draft: { ...s.draft, serviceType },
          fareEstimate: candidate,
          fareEstimatedAt: Date.now(),
        };
      }
      return { draft: { ...s.draft, serviceType } };
    }),

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
      // 'disputed' lives at the end so a `completed → disputed` realtime
      // update (once formal_disputes_enabled is on; valid_transitions added
      // the edge in 00409) isn't dropped by the forward-only guard below.
      // It is a terminal state reached from completed — not an "active" ride,
      // so getActiveRide intentionally does NOT list it.
      const STATUS_ORDER = ['searching', 'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed'];

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
      ride.status === 'in_progress' ||
      ride.status === 'arrived_at_destination'
    ) {
      set({ flowStep: 'active' });
    } else if (ride.status === 'completed') {
      // Sticky-serviceType fix (scenario #8): reset the service MODE the moment
      // the trip completes, so a mensajería order doesn't stay stuck if the user
      // leaves the rating screen without tapping "Listo". Keep flowStep='completed'
      // and activeRide so RideCompleteView still renders the summary (it reads
      // activeRide/rideWithDriver, NOT the draft — verified). Only the draft's
      // mode is reset; pickup/dropoff are left untouched.
      set((s) => ({
        flowStep: 'completed',
        draft: { ...s.draft, serviceType: 'triciclo_basico', delivery: { ...defaultDelivery } },
      }));
      // F009: Persist ride ID so review screen survives app restart
      AsyncStorage.setItem('@tricigo/pending_review_ride_id', ride.id).catch(() => {});
    } else if (ride.status === 'canceled') {
      // Sticky-serviceType fix: also reset the draft so a canceled mensajería
      // order doesn't leave serviceType='mensajeria' stuck on the next
      // passenger trip. Preserve prefetchedPickup (GPS auto-fill on home).
      set({
        flowStep: 'idle',
        draft: { ...defaultDraft },
        fareEstimate: null,
        fareEstimatedAt: null,
        allFareEstimates: null,
        promoCode: '',
        promoResult: null,
        splits: [],
        activeRide: null,
        rideWithDriver: null,
        error: null,
      });
    }
  },

  setLoading: (isLoading) => set({ isLoading }),
  setFareEstimating: (isFareEstimating) => set({ isFareEstimating }),
  setError: (error) => set({ error }),
  setPromoCode: (promoCode) => set({ promoCode }),
  setPromoResult: (promoResult) => set({ promoResult }),
  setAllFareEstimates: (allFareEstimates) => set({ allFareEstimates }),
  setCorporateAccount: (corporateAccountId) =>
    set((s) => {
      // Bug 23: Save previous payment method before switching to corporate so we can restore it on deselect
      if (corporateAccountId) {
        return {
          _prevPaymentMethod: s.draft.paymentMethod !== 'corporate' ? s.draft.paymentMethod : (s as any)._prevPaymentMethod ?? 'cash',
          draft: { ...s.draft, corporateAccountId, paymentMethod: 'corporate' as PaymentMethod },
        };
      }
      // Deselecting: restore previous payment method instead of defaulting to cash
      const restored: PaymentMethod = (s as any)._prevPaymentMethod ?? 'cash';
      return {
        draft: { ...s.draft, corporateAccountId: null, paymentMethod: s.draft.paymentMethod === 'corporate' ? restored : s.draft.paymentMethod },
      };
    }),
  setDeliveryField: (field, value) =>
    set((s) => {
      const delivery = { ...s.draft.delivery, [field]: value };
      // Al cambiar el vehículo de mensajería, resincronizar el fareEstimate
      // singular (label del botón / ETA / prechecks) al estimado de ese vehículo,
      // ya precargado en allFareEstimates. Sin esto el botón seguiría mostrando
      // el precio del vehículo anterior. Alinea con la web.
      const vt = delivery.deliveryVehicleType;
      if (field === 'deliveryVehicleType' && s.draft.serviceType === 'mensajeria' && vt) {
        const candidate = s.allFareEstimates?.[deliveryVehicleToSlug(vt)] ?? null;
        if (candidate) {
          return { draft: { ...s.draft, delivery }, fareEstimate: candidate, fareEstimatedAt: Date.now() };
        }
      }
      return { draft: { ...s.draft, delivery } };
    }),

  addWaypoint: () =>
    set((s) => {
      if (s.draft.waypoints.length >= RIDE_CONFIG.MAX_WAYPOINTS) return s;
      return {
        draft: { ...s.draft, waypoints: [...s.draft.waypoints, { address: '', location: null }] },
        fareEstimate: null,
        fareEstimatedAt: null,
      };
    }),

  removeWaypoint: (index) =>
    set((s) => ({
      draft: { ...s.draft, waypoints: s.draft.waypoints.filter((_, i) => i !== index) },
      fareEstimate: null,
      fareEstimatedAt: null,
    })),

  updateWaypoint: (index, address, location) =>
    set((s) => ({
      draft: {
        ...s.draft,
        waypoints: s.draft.waypoints.map((wp, i) =>
          i === index ? { address, location } : wp
        ),
      },
      fareEstimate: null,
      fareEstimatedAt: null,
    })),

  setInsurance: (insuranceSelected) =>
    set((s) => ({ draft: { ...s.draft, insuranceSelected } })),
  setPassengerCount: (passengerCount) =>
    set((s) => ({ draft: { ...s.draft, passengerCount } })),
  setShareRide: (shareRide) =>
    set((s) => ({ draft: { ...s.draft, shareRide } })),
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

  setWalletRatio: (walletRatio) =>
    set((s) => ({ draft: { ...s.draft, walletRatio: Math.max(0, Math.min(1, walletRatio)) } })),

  setRatingReminderId: (ratingReminderId) => set({ ratingReminderId }),

  // Sticky-serviceType fix: reset the service-type "mode" back to the
  // passenger default and wipe the delivery form, WITHOUT touching the
  // chosen pickup/dropoff/waypoints or the GPS-prefetched pickup. Called by
  // the destination-based entry points (search bar, recents, predictions,
  // "volver a último viaje", deep link) so a previous mensajería order never
  // leaks into a passenger trip. Wiping `delivery` makes each new envío start
  // blank (product decision: limpiar datos del envío cada vez).
  resetServiceSelection: () =>
    set((s) => ({
      draft: { ...s.draft, serviceType: 'triciclo_basico', delivery: { ...defaultDelivery } },
      fareEstimate: null,
      fareEstimatedAt: null,
    })),

  resetDraft: () =>
    set({ draft: { ...defaultDraft }, fareEstimate: null, fareEstimatedAt: null, allFareEstimates: null, error: null, promoCode: '', promoResult: null, splits: [], prefetchedPickup: null }),

  resetAll: () => {
    const { ratingReminderId } = get();
    if (ratingReminderId) {
      Notifications.cancelScheduledNotificationAsync(ratingReminderId).catch(() => {});
    }
    // F009: Clear pending review on reset
    AsyncStorage.removeItem('@tricigo/pending_review_ride_id').catch(() => {});
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
