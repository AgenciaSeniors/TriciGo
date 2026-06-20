'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';
import { formatTRC, formatTRCasUSD, formatCUP, findNearestPreset, serviceTypeToVehicleType, fetchETAsToPickup, enrichWithCrossStreets, adjustETAForVehicle, RIDE_CONFIG, haversineDistance } from '@tricigo/utils';
import type { LocationPreset } from '@tricigo/utils';
import { rideService, nearbyService, customerService, corporateService, walletService, deliveryService, useFeatureFlag } from '@tricigo/api';
import type { FareEstimate, ServiceTypeSlug, PaymentMethod, NearbyVehicle, VehicleType, CorporateAccount, PackageCategory, RidePreferences } from '@tricigo/types';
import { useGeolocation } from '../../hooks/useGeolocation';
import { useDestinationPredictions } from '../../hooks/useDestinationPredictions';
import { fetchRoute, reverseGeocode } from '../../services/geoService';
import { useAuth } from '../providers';
import { AddressAutocomplete } from '@/components/AddressAutocomplete';
import { SplitInviteBanner } from '@/components/SplitInviteBanner';
import { HomeDashboard } from '@/components/HomeDashboard';

/* Dynamic import — Mapbox GL JS requires `window` */
function MapLoadingFallback() {
  const { t } = useTranslation('web');
  return (
    <div
      style={{
        height: 420,
        width: '100%',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#1a1a2e',
        color: 'var(--text-secondary)',
        fontSize: 'var(--text-base)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      {t('web.loading_map', { defaultValue: 'Cargando mapa...' })}
    </div>
  );
}

const BookingMap = dynamic(() => import('./BookingMap'), {
  ssr: false,
  loading: () => <MapLoadingFallback />,
});

const SERVICE_TYPE_KEYS: { slug: ServiceTypeSlug; abbr: string; label: string; desc: string; icon: string }[] = [
  { slug: 'triciclo_basico', abbr: 'TC', label: 'Triciclo', desc: 'Econ\u00f3mico', icon: '/images/vehicles/triciclo.png' },
  { slug: 'moto_standard', abbr: 'MT', label: 'Moto', desc: 'R\u00e1pido', icon: '/images/vehicles/moto.png' },
  { slug: 'auto_standard', abbr: 'AT', label: 'Auto', desc: 'C\u00f3modo', icon: '/images/vehicles/auto.png' },
  { slug: 'auto_confort', abbr: 'CF', label: 'Confort', desc: 'Premium', icon: '/images/vehicles/confort.png' },
  { slug: 'mensajeria', abbr: 'DL', label: 'Env\u00edo', desc: 'Delivery', icon: '/images/vehicles/mensajeria.png' },
];

type SelectionStep = 'pickup' | 'dropoff' | 'done';

/** Unified recipient-phone validation for delivery (single source vs the 3
 *  divergent regexes that existed before). Accepts an optional country code
 *  and at least 6 digits total. */
function isValidRecipientPhone(phone: string): boolean {
  const trimmed = phone.trim();
  if (!trimmed) return false;
  if (!/^\+?\d{1,3}[\d\s-]{5,}$/.test(trimmed)) return false;
  return trimmed.replace(/[^\d]/g, '').length >= 6;
}

export default function BookPage() {
  const router = useRouter();
  const { t } = useTranslation('web');
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';

  /* ─── Saved locations & corporate accounts ─── */
  const [savedLocations, setSavedLocations] = useState<Array<{ label: string; address: string; latitude: number; longitude: number }>>([]);
  const [corporateAccounts, setCorporateAccounts] = useState<CorporateAccount[]>([]);
  const [selectedCorporateId, setSelectedCorporateId] = useState<string | null>(null);

  /* ─── Ride preferences (parity con app móvil) ───
     Saved in /profile/ride-preferences (customer_profiles.ride_preferences);
     sent as rider_preferences on createRide so the driver sees them — same
     source + shape as the mobile client (useRide.ts). */
  const ridePreferencesEnabled = useFeatureFlag('ride_preferences_enabled');
  const [ridePrefs, setRidePrefs] = useState<RidePreferences>({});

  useEffect(() => {
    async function loadSaved() {
      try {
        const { getSupabaseClient } = await import('@tricigo/api');
        const supabase = getSupabaseClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const profile = await customerService.getProfile(user.id);
        if (profile?.saved_locations?.length) {
          setSavedLocations(profile.saved_locations.filter((l: any) => l.latitude && l.longitude));
        }
        if (profile?.ride_preferences) {
          setRidePrefs(profile.ride_preferences);
        }
        corporateService.getMyAccounts(user.id).then(setCorporateAccounts).catch(() => {});
      } catch { /* ignore — saved locations are optional */ }
    }
    loadSaved();
  }, []);

  /* ─── Location state ─── */
  const [pickup, setPickup] = useState<LocationPreset | null>(null);
  const [dropoff, setDropoff] = useState<LocationPreset | null>(null);
  const [selectionStep, setSelectionStep] = useState<SelectionStep>('pickup');
  const [mapCenter, setMapCenter] = useState({ latitude: 23.1136, longitude: -82.3666 });

  /* ─── Ride state ─── */
  const [serviceType, setServiceType] = useState<ServiceTypeSlug>('triciclo_basico');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('tricigo_payment_method');
      if (saved === 'cash' || saved === 'tricicoin' || saved === 'mixed') return saved as PaymentMethod;
    }
    return 'cash';
  });
  const [walletRatio, setWalletRatio] = useState(0.5);
  const [walletBalance, setWalletBalance] = useState<number>(0);
  const [estimate, setEstimate] = useState<FareEstimate | null>(null);
  const [allEstimates, setAllEstimates] = useState<Record<string, FareEstimate | null>>({});
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [deliveryVehicle, setDeliveryVehicle] = useState<ServiceTypeSlug>('moto_standard');
  const selectedEstimate = serviceType === 'mensajeria'
    ? allEstimates[deliveryVehicle] || null
    : allEstimates[serviceType] || null;

  // Deep link: /book?service=<slug> preselects the service. Campaign CTAs use
  // it (announcementCtaWebHref maps "Enviar paquete" → /book?service=mensajeria)
  // and it makes the booking link shareable with a service preselected.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const param = new URLSearchParams(window.location.search).get('service');
    if (param && SERVICE_TYPE_KEYS.some((s) => s.slug === param)) {
      setServiceType(param as ServiceTypeSlug);
    }
  }, []);
  const [showOptions, setShowOptions] = useState(false);
  const [isEstimating, setIsEstimating] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ─── Route & address state ─── */
  const [pickupAddress, setPickupAddress] = useState<string | null>(null);
  const [dropoffAddress, setDropoffAddress] = useState<string | null>(null);
  const [routeCoords, setRouteCoords] = useState<[number, number][] | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeInfo, setRouteInfo] = useState<{ distance_m: number; duration_s: number } | null>(null);

  /* ─── Center pin state (for BookingMap) ─── */
  const [centerAddress, setCenterAddress] = useState<string | null>(null);
  const [centerAddressLoading, setCenterAddressLoading] = useState(false);
  const centerGeoIdRef = useRef(0); // Race condition guard for reverse geocode
  const pickupGeoIdRef = useRef(0); // Race condition guard for pickup reverse geocode
  const dropoffGeoIdRef = useRef(0); // Race condition guard for dropoff reverse geocode
  const [flyToTarget, setFlyToTarget] = useState<{ latitude: number; longitude: number } | null>(null);

  /* ─── Waypoints state (W1.1) ─── */
  const [waypoints, setWaypoints] = useState<LocationPreset[]>([]);
  const [addingWaypoint, setAddingWaypoint] = useState(false);

  /* ─── Promo code state (W1.3) ─── */
  const [promoCode, setPromoCode] = useState('');
  const [promoValidating, setPromoValidating] = useState(false);
  const [promoResult, setPromoResult] = useState<{ valid: boolean; promoId?: string; discount: number; error?: string } | null>(null);

  // PASS #3 PROMO-STALE (extendido en PASS 2): clear a validated promo when
  // ANYTHING the discount was computed against changes — service type, the
  // route (pickup/dropoff), or the delivery vehicle. The server trigger
  // recomputes the discount over the NEW fare, so a stale "-$600" chip over a
  // cheaper route showed a total the server would never charge.
  useEffect(() => {
    setPromoResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceType, deliveryVehicle, pickup?.latitude, pickup?.longitude, dropoff?.latitude, dropoff?.longitude]);

  /* ─── Shared ride (triciclo only) + passenger count ─── */
  const [shareRide, setShareRide] = useState(false);
  const [passengerCount, setPassengerCount] = useState(1);
  // Shared-ride per-seat discount % (admin-configurable; fallback 7). Read once
  // so the displayed price matches what the server trigger (00347) applies.
  const [sharePct, setSharePct] = useState(7);
  useEffect(() => {
    walletService.getConfigValue('shared_ride_discount_per_seat_pct')
      .then((v) => { const n = v != null ? parseFloat(v) : NaN; if (Number.isFinite(n) && n > 0) setSharePct(n); })
      .catch(() => { /* keep fallback 7% */ });
  }, []);
  // Pre-fill the promo field from a /promo/<code> deep link (?promo=) or a
  // pending code stashed by /promo/<code> for a guest who then logged in. The
  // rider taps "Aplicar" once a fare estimate exists (validation needs a fare).
  useEffect(() => {
    let pending: string | null = null;
    try {
      pending = new URLSearchParams(window.location.search).get('promo')
        || sessionStorage.getItem('tricigo_pending_promo');
      if (pending) sessionStorage.removeItem('tricigo_pending_promo');
    } catch { /* ignore */ }
    if (pending) setPromoCode(pending.trim());
  }, []);
  // Shared-ride discount (triciclo only) + the price the rider actually pays =
  // estimate − promo − shareDiscount. The server trigger (00347) applies the
  // same shared discount to discount_amount_cup, so this mirrors the real total.
  const shareOccSeats = Math.min(Math.max(passengerCount, 1), 3);
  const shareFreeSeats = (serviceType === 'triciclo_basico' && shareRide) ? (4 - shareOccSeats) : 0;
  const shareDiscountCup = selectedEstimate && shareFreeSeats > 0
    ? Math.floor(selectedEstimate.estimated_fare_cup * shareFreeSeats * (sharePct / 100))
    : 0;
  const promoDiscountCup = promoResult?.valid ? Math.max(0, promoResult.discount ?? 0) : 0;
  const displayFareCup = Math.max((selectedEstimate?.estimated_fare_cup ?? 0) - promoDiscountCup - shareDiscountCup, 0);
  const displayFareTrc = (promoDiscountCup > 0 || shareDiscountCup > 0) ? undefined : (selectedEstimate?.estimated_fare_trc ?? undefined);

  /* ─── Schedule a future ride (parity con app móvil) ─── */
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');

  /* ─── Estimate freshness (X1.3: reject stale > FARE_ESTIMATE_TTL_MS) ─── */
  const fareEstimatedAtRef = useRef<number | null>(null);

  /* ─── Double-submit guards (sync refs — state updates are async) ─── */
  const isSubmittingRef = useRef(false);
  const pendingRequestIdRef = useRef<string | null>(null);

  /* ─── Delivery state ─── */
  const [deliveryDetails, setDeliveryDetails] = useState({
    recipient_name: '',
    recipient_phone: '',
    package_description: '',
    package_category: 'paquete_pequeno' as string,
    estimated_weight_kg: '',
    special_instructions: '',
    client_accompanies: false,
    package_length_cm: '',
    package_width_cm: '',
    package_height_cm: '',
  });

  /* ─── Nearby vehicles state ─── */
  const [nearbyVehicles, setNearbyVehicles] = useState<NearbyVehicle[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);
  const realtimeChannelRef = useRef<ReturnType<typeof nearbyService.subscribeToDriverPositions> | null>(null);

  /* ─── ETA by vehicle type (closest driver per type) ─── */
  const [etaByType, setEtaByType] = useState<Record<VehicleType, number | null>>({
    triciclo: null,
    moto: null,
    auto: null,
    confort: null,
  });

  /* ─── Fetch nearby vehicles when pickup changes ─── */
  useEffect(() => {
    if (!pickup) {
      setNearbyVehicles([]);
      setEtaByType({ triciclo: null, moto: null, auto: null, confort: null });
      return;
    }

    let cancelled = false;

    async function fetchVehicles() {
      setVehiclesLoading(true);
      try {
        const vehicles = await nearbyService.findNearbyVehicles({
          lat: pickup!.latitude,
          lng: pickup!.longitude,
          vehicleType: null,
          // Match the mobile client's useNearbyVehicles (5km / 30) for parity.
          radiusM: 5000,
          limit: 30,
        });
        if (cancelled) return;
        setNearbyVehicles(vehicles);

        // Calculate ETA per vehicle type (closest driver of each type)
        const typeGroups: Record<VehicleType, NearbyVehicle | null> = { triciclo: null, moto: null, auto: null, confort: null };
        for (const v of vehicles) {
          const vt = v.vehicle_type as VehicleType;
          if (vt && !typeGroups[vt]) {
            typeGroups[vt] = v; // first = closest (RPC returns sorted by distance)
          }
        }

        const closestPerType = (['triciclo', 'moto', 'auto', 'confort'] as VehicleType[])
          .map((vt) => typeGroups[vt])
          .filter(Boolean) as NearbyVehicle[];

        if (closestPerType.length > 0) {
          const origins = closestPerType.map((v) => ({ lat: v.latitude, lng: v.longitude }));
          const dest = { lat: pickup!.latitude, lng: pickup!.longitude };
          const etas = await fetchETAsToPickup(origins, dest);

          if (!cancelled) {
            const VT_TO_SERVICE: Record<VehicleType, ServiceTypeSlug> = {
              triciclo: 'triciclo_basico', moto: 'moto_standard', auto: 'auto_standard', confort: 'auto_confort',
            };
            const newEtas: Record<VehicleType, number | null> = { triciclo: null, moto: null, auto: null, confort: null };
            let idx = 0;
            for (const vt of ['triciclo', 'moto', 'auto', 'confort'] as VehicleType[]) {
              if (typeGroups[vt]) {
                const etaResult = etas[idx];
                if (etaResult) {
                  const adjustedS = adjustETAForVehicle(etaResult.duration_s, VT_TO_SERVICE[vt]);
                  newEtas[vt] = Math.ceil(adjustedS / 60);
                }
                idx++;
              }
            }
            setEtaByType(newEtas);
          }
        } else if (!cancelled) {
          setEtaByType({ triciclo: null, moto: null, auto: null, confort: null });
        }
      } catch (err) {
        console.warn('Failed to fetch nearby vehicles:', err);
        if (!cancelled) {
          setNearbyVehicles([]);
          setEtaByType({ triciclo: null, moto: null, auto: null, confort: null });
        }
      } finally {
        if (!cancelled) setVehiclesLoading(false);
      }
    }

    fetchVehicles();
    return () => { cancelled = true; };
  }, [pickup]);

  /* ─── Subscribe to real-time driver positions ─── */
  useEffect(() => {
    let isMounted = true;
    const channel = nearbyService.subscribeToDriverPositions((update) => {
      if (!isMounted) return;
      setNearbyVehicles((prev) =>
        prev.map((v) =>
          v.driver_profile_id === update.driver_profile_id
            ? { ...v, latitude: update.latitude, longitude: update.longitude, heading: update.heading }
            : v,
        ),
      );
    });
    realtimeChannelRef.current = channel;

    return () => {
      isMounted = false;
      if (realtimeChannelRef.current) {
        realtimeChannelRef.current.unsubscribe();
        realtimeChannelRef.current = null;
      }
    };
  }, []);

  /* ─── Reverse geocode map center for center pin ─── */
  useEffect(() => {
    if (selectionStep === 'done') {
      setCenterAddress(null);
      return;
    }
    setCenterAddressLoading(true);
    const geoId = ++centerGeoIdRef.current;
    const timeout = setTimeout(async () => {
      try {
        const addr = await reverseGeocode(mapCenter.latitude, mapCenter.longitude);
        // Only update if this is still the latest request (race condition guard)
        if (geoId !== centerGeoIdRef.current) return;
        setCenterAddress(addr);
      } catch {
        if (geoId !== centerGeoIdRef.current) return;
        setCenterAddress(null);
      } finally {
        if (geoId === centerGeoIdRef.current) setCenterAddressLoading(false);
      }
    }, 400);
    return () => clearTimeout(timeout);
  }, [mapCenter.latitude, mapCenter.longitude, selectionStep]);

  /* ─── Geolocation ─── */
  const {
    latitude: userLat,
    longitude: userLng,
    loading: geoLoading,
    error: geoError,
    requestLocation,
  } = useGeolocation();
  const userLocation = userLat && userLng ? { latitude: userLat, longitude: userLng } : null;

  /* ─── Destination predictions (clustered from completed-ride history) ─── */
  const { predictions: destinationPredictions } = useDestinationPredictions(user?.id);

  /* ─── Auto-set pickup from user location (like Uber) ─── */
  const autoSetPickupRef = useRef(false);

  useEffect(() => {
    if (autoSetPickupRef.current) return; // Only once
    if (!userLat || !userLng || pickup) return; // Need coords + no pickup yet

    autoSetPickupRef.current = true;

    // Fly map to user's location immediately (before reverse geocode resolves)
    setFlyToTarget({ latitude: userLat, longitude: userLng });

    (async () => {
      try {
        const address = await reverseGeocode(userLat, userLng);
        if (!address) return;
        handleSetPickup({
          label: address,
          address: address,
          latitude: userLat,
          longitude: userLng,
        });
      } catch { /* ignore — user can set manually */ }
    })();
  }, [userLat, userLng, pickup]);

  /* ─── Persist payment method ─── */
  useEffect(() => {
    localStorage.setItem('tricigo_payment_method', paymentMethod);
  }, [paymentMethod]);

  /* ─── Load wallet balance ─── */
  useEffect(() => {
    if (!user?.id) return;
    walletService.getBalance(user.id).then(({ available }) => {
      setWalletBalance(available);
    }).catch(() => {
      // Cached balance is only used for the mixed-payment slider clamp; the
      // authoritative check re-fetches fresh balance at confirm time.
    });
  }, [user?.id]);

  /** Format price based on current payment method */
  function formatPrice(cupAmount: number, trcAmount?: number): string {
    if (paymentMethod === 'tricicoin') {
      return formatTRC(trcAmount ?? cupAmount);
    }
    return formatCUP(cupAmount);
  }

  /** Get the fare amount based on current payment method */
  function getFareAmount(est: FareEstimate | null): number {
    if (!est) return 0;
    return paymentMethod === 'tricicoin' ? (est.estimated_fare_trc ?? est.estimated_fare_cup) : est.estimated_fare_cup;
  }

  /* ─── Route helper ─── */
  async function loadRoute(from: LocationPreset, to: LocationPreset) {
    setRouteLoading(true);
    setRouteCoords(null);
    setRouteInfo(null);
    try {
      const result = await fetchRoute(
        { lat: from.latitude, lng: from.longitude },
        { lat: to.latitude, lng: to.longitude },
      );
      if (result) {
        setRouteCoords(result.coordinates);
        setRouteInfo({ distance_m: result.distance_m, duration_s: result.duration_s });
      }
    } catch {
      // Fallback: straight line will be shown
    } finally {
      setRouteLoading(false);
    }
  }

  /* ─── Map handlers ─── */
  function handleSetPickup(loc: LocationPreset) {
    setPickup(loc);
    setEstimate(null);
    setAllEstimates({});
    setSelectionStep(dropoff ? 'done' : 'dropoff');
    // If address already contains cross-streets (from Cuban search), use it directly
    if (loc.address && loc.address.includes('e/')) {
      setPickupAddress(loc.address);
    } else {
      setPickupAddress(null);
      const geoId = ++pickupGeoIdRef.current;
      reverseGeocode(loc.latitude, loc.longitude).then((addr) => {
        if (geoId !== pickupGeoIdRef.current) return; // Discard stale result
        if (addr) setPickupAddress(addr);
      });
    }
    if (dropoff) {
      loadRoute(loc, dropoff);
    }
    setFlyToTarget({ latitude: loc.latitude, longitude: loc.longitude });
  }

  function handleSetDropoff(loc: LocationPreset) {
    setDropoff(loc);
    setEstimate(null);
    setAllEstimates({});
    setSelectionStep(pickup ? 'done' : 'pickup');
    // If address already contains cross-streets (from Cuban search), use it directly
    if (loc.address && loc.address.includes('e/')) {
      setDropoffAddress(loc.address);
    } else {
      setDropoffAddress(null);
      const geoId = ++dropoffGeoIdRef.current;
      reverseGeocode(loc.latitude, loc.longitude).then((addr) => {
        if (geoId !== dropoffGeoIdRef.current) return; // Discard stale result
        if (addr) setDropoffAddress(addr);
      });
    }
    // Fetch route if pickup already set
    if (pickup) {
      loadRoute(pickup, loc);
    }
    setFlyToTarget({ latitude: loc.latitude, longitude: loc.longitude });
  }

  function handleConfirmLocation(loc: LocationPreset) {
    if (selectionStep === 'pickup') {
      handleSetPickup(loc);
    } else if (selectionStep === 'dropoff') {
      handleSetDropoff(loc);
    }
  }

  function handleResetMap() {
    setPickup(null);
    setDropoff(null);
    setEstimate(null);
    setAllEstimates({});
    setPickupAddress(null);
    setDropoffAddress(null);
    setRouteCoords(null);
    setRouteInfo(null);
    setSelectionStep('pickup');
    setWaypoints([]);
    setPromoCode('');
    setPromoResult(null);
    setShareRide(false);
    setPassengerCount(1);
    fareEstimatedAtRef.current = null;
    setDeliveryDetails({ recipient_name: '', recipient_phone: '', package_description: '', package_category: 'paquete_pequeno', estimated_weight_kg: '', special_instructions: '', client_accompanies: false, package_length_cm: '', package_width_cm: '', package_height_cm: '' });
  }

  function handleSwapLocations() {
    const tempPickup = pickup;
    const tempPickupAddr = pickupAddress;
    setPickup(dropoff);
    setPickupAddress(dropoffAddress);
    setDropoff(tempPickup);
    setDropoffAddress(tempPickupAddr);
    setEstimate(null);
    setAllEstimates({});
    setRouteCoords(null);
    setRouteInfo(null);
  }

  async function handleUseMyLocation() {
    try {
      const coords = await requestLocation();
      // Always use reverse geocoding for accurate street address with cross streets
      const address = await reverseGeocode(coords.latitude, coords.longitude);
      const label = address || `${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}`;
      const preset: LocationPreset = {
        label,
        address: address || `${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}`,
        latitude: coords.latitude,
        longitude: coords.longitude,
      };
      if (selectionStep === 'pickup') {
        handleSetPickup(preset);
      } else if (selectionStep === 'dropoff') {
        handleSetDropoff(preset);
      }
    } catch {
      // Error is handled by the hook state — displayed by BookingMap
    }
  }

  /* ─── Ride estimate/request ─── */
  const canEstimate =
    pickup &&
    dropoff &&
    (pickup.latitude !== dropoff.latitude || pickup.longitude !== dropoff.longitude);

  async function handleEstimate() {
    if (!pickup || !dropoff) return;
    setIsEstimating(true);
    setError(null);
    try {
      const result = await rideService.getLocalFareEstimate({
        service_type: serviceType,
        pickup_lat: pickup.latitude,
        pickup_lng: pickup.longitude,
        dropoff_lat: dropoff.latitude,
        dropoff_lng: dropoff.longitude,
        // Stops must shape the estimate (the mobile client passes them; the
        // web omitted them everywhere, so the shown price ignored up to 3
        // stops while the server charged the real multi-stop route).
        waypoints: waypoints.length > 0 ? waypoints.map((w) => ({ lat: w.latitude, lng: w.longitude })) : undefined,
      });
      setEstimate(result);
    } catch (err) {
      setError(t('book.error_estimate'));
      console.error(err);
    } finally {
      setIsEstimating(false);
    }
  }

  const handleEstimateAll = useCallback(async () => {
    if (!pickup || !dropoff || estimateLoading) return;
    setEstimateLoading(true);
    setAllEstimates({});

    const serviceTypes: ServiceTypeSlug[] = ['triciclo_basico', 'moto_standard', 'auto_standard', 'auto_confort'];

    try {
      const results = await Promise.allSettled(
        serviceTypes.map(st =>
          rideService.getLocalFareEstimate({
            pickup_lat: pickup.latitude,
            pickup_lng: pickup.longitude,
            dropoff_lat: dropoff.latitude,
            dropoff_lng: dropoff.longitude,
            service_type: st,
            waypoints: waypoints.length > 0 ? waypoints.map((w) => ({ lat: w.latitude, lng: w.longitude })) : undefined,
          })
        )
      );

      const estimates: Record<string, FareEstimate | null> = {};
      serviceTypes.forEach((st, i) => {
        const r = results[i];
        estimates[st] = r.status === 'fulfilled' ? r.value : null;
      });
      setAllEstimates(estimates);
      fareEstimatedAtRef.current = Date.now();
    } catch {
      // Silently fail — user can retry
    } finally {
      setEstimateLoading(false);
    }
  }, [pickup, dropoff, estimateLoading, waypoints]);

  /* ─── Auto-fetch estimates when both locations set ─── */
  useEffect(() => {
    if (pickup && dropoff && Object.keys(allEstimates).length === 0 && !estimateLoading) {
      handleEstimateAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickup?.latitude, pickup?.longitude, dropoff?.latitude, dropoff?.longitude, waypoints]);

  /* ─── Promo code validation ─── */
  async function handleApplyPromo() {
    const code = promoCode.trim();
    if (!code) return;
    if (!selectedEstimate) {
      setPromoResult({ valid: false, discount: 0, error: t('booking.select_service_first', { defaultValue: 'Selecciona un servicio primero' }) });
      return;
    }
    setPromoValidating(true);
    setPromoResult(null);
    try {
      const result = await rideService.validatePromoCode({
        code,
        userId: user?.id || '',
        fareAmount: selectedEstimate.estimated_fare_cup,
      });
      if (result.valid && result.promotion) {
        setPromoResult({ valid: true, promoId: result.promotion.id, discount: result.discountAmount });
      } else {
        const msgs: Record<string, string> = {
          invalid: t('book.promo_error_invalid', { defaultValue: 'Código no válido' }),
          expired: t('book.promo_error_expired', { defaultValue: 'Código expirado' }),
          max_uses: t('book.promo_error_max_uses', { defaultValue: 'Código agotado' }),
          already_used: t('book.promo_error_already_used', { defaultValue: 'Ya usaste este código' }),
        };
        setPromoResult({ valid: false, discount: 0, error: msgs[result.error || 'invalid'] || t('book.promo_error_invalid', { defaultValue: 'Código no válido' }) });
      }
    } catch {
      setPromoResult({ valid: false, discount: 0, error: t('book.promo_error_generic', { defaultValue: 'Error al validar código' }) });
    } finally {
      setPromoValidating(false);
    }
  }

  async function handleRequest() {
    if (!pickup || !dropoff || !selectedEstimate) return;

    // Double-submit guard — sync refs (state updates are async). Mirrors client useRide.
    if (isSubmittingRef.current || pendingRequestIdRef.current !== null) return;

    // Reject a stale fare estimate (>FARE_ESTIMATE_TTL_MS, 5 min). Mirrors the
    // client's X1.3 guard (useRide.ts:424-432): a rider who left the tab open
    // shouldn't book at a price computed long ago. We auto-refresh the estimate
    // and ask them to re-confirm at the fresh price.
    const estimatedAt = fareEstimatedAtRef.current;
    if (!estimatedAt || Date.now() - estimatedAt > RIDE_CONFIG.FARE_ESTIMATE_TTL_MS) {
      setError(t('book.estimate_expired', { defaultValue: 'El precio expiró por inactividad. Actualizamos la tarifa — revisá y confirmá de nuevo.' }));
      handleEstimateAll();
      return;
    }

    // Minimum distance 200m (guards pickup≈dropoff). Mirrors client Bug 25.
    const confirmDist = haversineDistance(
      { latitude: pickup.latitude, longitude: pickup.longitude },
      { latitude: dropoff.latitude, longitude: dropoff.longitude },
    );
    if (confirmDist < RIDE_CONFIG.MIN_DISTANCE_M) {
      setError(t('book.too_close', { defaultValue: 'El destino está a menos de 200m del punto de recogida. Selecciona un destino más lejano.' }));
      return;
    }

    // Block while a promo is still validating (Bug 12/24).
    if (promoValidating) {
      setError(t('book.wait_promo', { defaultValue: 'Espera, validando código...' }));
      return;
    }

    // Validate delivery fields (cheap, sync) before entering the submitting state.
    if (serviceType === 'mensajeria') {
      if (!deliveryDetails.recipient_name.trim()) {
        setError(t('book.delivery_name_required', { defaultValue: 'Ingresa el nombre del destinatario' }));
        return;
      }
      if (!isValidRecipientPhone(deliveryDetails.recipient_phone)) {
        setError(t('book.delivery_phone_invalid', { defaultValue: 'Ingresa un número de teléfono válido para el destinatario' }));
        return;
      }
    }

    const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    pendingRequestIdRef.current = requestId;
    isSubmittingRef.current = true;
    setIsRequesting(true);
    setError(null);

    try {
      const activeSlug = serviceType === 'mensajeria' ? deliveryVehicle : serviceType;
      const isDelivery = serviceType === 'mensajeria';

      // ─── Balance validation with fresh fetch + 1.2× surge buffer (Bug 9/26) ───
      if (paymentMethod === 'tricicoin' || paymentMethod === 'mixed') {
        let available: number;
        try {
          const bal = await walletService.getBalance(user!.id);
          available = bal.available;
        } catch {
          setError(t('book.balance_check_failed', { defaultValue: 'No se pudo verificar tu saldo. Intenta de nuevo o cambia a efectivo.' }));
          return;
        }
        if (paymentMethod === 'tricicoin') {
          const requiredTrc = selectedEstimate.estimated_fare_trc ?? selectedEstimate.estimated_fare_cup;
          if (available < requiredTrc * 1.2) {
            router.push('/wallet');
            return;
          }
        } else {
          const walletPart = selectedEstimate.estimated_fare_cup * walletRatio;
          if (available < walletPart * 1.2) {
            setError(t('book.insufficient_balance_mixed', { defaultValue: 'Saldo insuficiente para la parte wallet del pago mixto. Ajusta el porcentaje o recarga tu wallet.' }));
            return;
          }
        }
      }

      // ─── Corporate budget re-check (BUG-073) ───
      if (paymentMethod === 'corporate' && selectedCorporateId) {
        try {
          const fresh = await corporateService.getAccount(selectedCorporateId);
          // monthly_budget_trc = 0 means UNLIMITED (schema default; the
          // server validator only enforces when budget > 0) — the old check
          // blocked every ride for unlimited-budget accounts.
          if ((fresh?.monthly_budget_trc ?? 0) > 0) {
            const remaining = (fresh?.monthly_budget_trc ?? 0) - (fresh?.current_month_spent ?? 0);
            if (remaining < (selectedEstimate.estimated_fare_trc ?? 0)) {
              setError(t('book.corporate_budget_exceeded', { defaultValue: 'El presupuesto corporativo disponible no cubre este viaje.' }));
              return;
            }
          }
        } catch {
          // Allow ride to proceed — server enforces budget limits.
        }
      }

      // ─── Re-estimate at request time (fresh price); abort if Δ>5% (X1.3 freshness) ───
      let freshEstimate = selectedEstimate;
      try {
        const reEstimated = await rideService.getLocalFareEstimate({
          service_type: activeSlug,
          pickup_lat: pickup.latitude,
          pickup_lng: pickup.longitude,
          dropoff_lat: dropoff.latitude,
          dropoff_lng: dropoff.longitude,
          waypoints: waypoints.length > 0 ? waypoints.map((w) => ({ lat: w.latitude, lng: w.longitude })) : undefined,
        });
        setAllEstimates(prev => ({ ...prev, [activeSlug]: reEstimated }));
        fareEstimatedAtRef.current = Date.now();
        freshEstimate = reEstimated;
        const oldFare = selectedEstimate.estimated_fare_cup;
        const newFare = reEstimated.estimated_fare_cup;
        if (oldFare > 0 && Math.abs(newFare - oldFare) / oldFare > 0.05) {
          setError(t('book.price_updated', {
            defaultValue: `El precio se actualizó de ${formatCUP(oldFare)} a ${formatCUP(newFare)}. Revisa y confirma de nuevo.`,
            old: formatCUP(oldFare),
            new: formatCUP(newFare),
          }));
          return;
        }
      } catch {
        // If re-estimation fails, proceed with original estimate.
      }

      const ride = await rideService.createRide({
        service_type: activeSlug,
        ride_mode: isDelivery ? 'cargo' : 'passenger',
        payment_method: paymentMethod,
        pickup_latitude: pickup.latitude,
        pickup_longitude: pickup.longitude,
        pickup_address: pickup.address || pickup.label,
        dropoff_latitude: dropoff.latitude,
        dropoff_longitude: dropoff.longitude,
        dropoff_address: dropoff.address || dropoff.label,
        estimated_fare_cup: freshEstimate.estimated_fare_cup,
        estimated_distance_m: freshEstimate.estimated_distance_m,
        estimated_duration_s: freshEstimate.estimated_duration_s,
        // Price snapshot breakdown so complete_ride_and_pay charges the same
        // rates the rider saw (parity surge + pricing_rule_id + rates).
        base_fare_cup: freshEstimate.base_fare_cup,
        per_km_rate_cup: freshEstimate.per_km_rate_cup,
        per_minute_rate_cup: freshEstimate.per_minute_rate_cup,
        min_fare_cup: freshEstimate.min_fare_cup,
        surge_multiplier: freshEstimate.surge_multiplier,
        pricing_rule_id: freshEstimate.pricing_rule_id || undefined,
        promo_code_id: promoResult?.valid ? promoResult.promoId : undefined,
        discount_amount_cup: promoResult?.valid ? Math.max(0, promoResult.discount ?? 0) : undefined,
        ...(waypoints.length > 0 && {
          waypoints: waypoints.map((wp, i) => ({
            sort_order: i + 1,
            latitude: wp.latitude,
            longitude: wp.longitude,
            address: wp.address || wp.label,
          })),
        }),
        ...(selectedCorporateId && { corporate_account_id: selectedCorporateId }),
        // Rider preferences saved in /profile/ride-preferences — same shape and
        // emptiness check as the mobile client (useRide.ts), gated by the
        // ride_preferences_enabled flag.
        rider_preferences: ridePreferencesEnabled && Object.keys(ridePrefs).length > 0 ? ridePrefs : undefined,
        // "Compartir viaje" — only the tricycle. Server trigger (00347) computes
        // the discount; declared_passengers = seats the rider occupies.
        share_ride: serviceType === 'triciclo_basico' ? shareRide : false,
        declared_passengers: shareRide && serviceType === 'triciclo_basico' ? passengerCount : undefined,
        // Mixed payment: forward the rider's wallet/cash split. Without this the
        // ride defaults to wallet_ratio=0 → wallet portion 0 → charged all as
        // cash and the split never shows. Only for 'mixed'; ignored otherwise.
        wallet_ratio: paymentMethod === 'mixed' ? walletRatio : undefined,
        // Schedule a future ride — only when the toggle is on AND a date is
        // picked. The spread keeps scheduled_at absent for on-demand rides.
        ...(isScheduled && scheduleDate && { scheduled_at: new Date(scheduleDate).toISOString() }),
      });

      // Delivery details as a blocking step — cancel the ride if it fails so it
      // never exists without its delivery metadata (mirrors client Bug 30).
      if (isDelivery) {
        try {
          await deliveryService.createDeliveryDetails({
            ride_id: ride.id,
            package_description: deliveryDetails.package_description || 'Delivery',
            recipient_name: deliveryDetails.recipient_name,
            recipient_phone: deliveryDetails.recipient_phone,
            estimated_weight_kg: deliveryDetails.estimated_weight_kg ? parseFloat(deliveryDetails.estimated_weight_kg) : undefined,
            special_instructions: deliveryDetails.special_instructions || undefined,
            package_category: (deliveryDetails.package_category as PackageCategory) || undefined,
            package_length_cm: deliveryDetails.package_length_cm ? parseInt(deliveryDetails.package_length_cm, 10) : undefined,
            package_width_cm: deliveryDetails.package_width_cm ? parseInt(deliveryDetails.package_width_cm, 10) : undefined,
            package_height_cm: deliveryDetails.package_height_cm ? parseInt(deliveryDetails.package_height_cm, 10) : undefined,
            client_accompanies: deliveryDetails.client_accompanies,
            delivery_vehicle_type: serviceTypeToVehicleType(deliveryVehicle) ?? undefined,
          });
        } catch (deliveryErr) {
          try {
            await rideService.cancelRide(ride.id, 'delivery_details_failed');
          } catch { /* best-effort cleanup */ }
          console.error('[Book] delivery details failed — ride cancelled:', deliveryErr);
          setError(t('book.delivery_details_failed', { defaultValue: 'No se pudieron guardar los detalles del envío. Intenta de nuevo.' }));
          return;
        }
      }

      // Scheduled rides have no live tracking yet — send the rider to the list
      // of scheduled rides; on-demand rides go straight to live tracking.
      router.push(isScheduled ? '/rides' : `/track/${ride.id}`);
    } catch (err) {
      console.error('[Book] createRide failed:', err);
      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes('Not authenticated') || msg.includes('Missing')) {
        setError('Debes iniciar sesión para solicitar un viaje.');
      } else if (msg.includes('outside the service area')) {
        setError('La ubicación está fuera del área de servicio.');
      } else if (msg.includes('Validation error')) {
        setError('Datos del viaje incompletos. Verifica origen y destino.');
      } else {
        setError(`Error al solicitar viaje: ${msg}`);
      }
    } finally {
      isSubmittingRef.current = false;
      pendingRequestIdRef.current = null;
      setIsRequesting(false);
    }
  }

  /* ─── Auth gate (after all hooks) ─── */
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.replace('/login');
    }
  }, [authLoading, isAuthenticated, router]);

  if (authLoading || !isAuthenticated) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: '#00C853' }}>Go</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className="page-main">
      <div className="page-container">
        <Link
          href="/"
          aria-label="Volver al inicio"
          style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}
        >
          {t('book.back')}
        </Link>

        <h1
          style={{
            fontSize: 'clamp(1.5rem, 4vw, 2rem)',
            fontWeight: 800,
            marginTop: '1rem',
            marginBottom: '0.5rem',
          }}
        >
          {t('book.title')}
        </h1>
        <p style={{ color: 'var(--text-tertiary)', marginBottom: '1.5rem' }}>{t('book.subtitle')}</p>

        {/* Incoming fare-split invites (parity con SplitInviteCard del home
            móvil) — polls getMySplitInvites; accept/decline inline. */}
        <SplitInviteBanner userId={user?.id ?? null} />

        {/* ═══ Address Autocomplete (WF-2) ═══ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1rem' }}>
          <AddressAutocomplete
            label={t('web.address_origin', { defaultValue: 'Origen' })}
            placeholder={t('book.pickup_placeholder', { defaultValue: '¿Dónde te recogemos?' })}
            value={pickupAddress || ''}
            mapboxToken={mapboxToken}
            savedLocations={savedLocations}
            proximity={mapCenter}
            enrichAddress={enrichWithCrossStreets}
            onSelect={(r) => {
              const loc = { label: r.place_name, address: r.address, latitude: r.latitude, longitude: r.longitude };
              handleSetPickup(loc);
            }}
            onClear={() => {
              setPickup(null);
              setPickupAddress(null);
              setSelectionStep('pickup');
              setEstimate(null);
              // allEstimates feeds selectedEstimate — without clearing it the
              // old fare card stayed visible and the CTA was enabled but dead.
              setAllEstimates({});
              setRouteCoords(null);
              setRouteInfo(null);
            }}
          />

          {/* Swap button */}
            <div style={{ display: 'flex', justifyContent: 'center', margin: '-0.25rem 0', opacity: pickup && dropoff ? 1 : 0.3, pointerEvents: pickup && dropoff ? 'auto' : 'none' }}>
              <button
                type="button"
                onClick={handleSwapLocations}
                aria-label="Intercambiar origen y destino"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  border: '1px solid var(--border)',
                  background: 'var(--card-bg)',
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                  fontSize: '1rem',
                  transition: 'all 0.15s',
                  zIndex: 1,
                }}
                onMouseOver={(e) => { e.currentTarget.style.background = 'var(--primary)'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = 'var(--primary)'; }}
                onMouseOut={(e) => { e.currentTarget.style.background = 'var(--card-bg)'; e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
              >
                ↕
              </button>
            </div>

          <AddressAutocomplete
            label={t('web.address_destination', { defaultValue: 'Destino' })}
            placeholder={t('book.dropoff_placeholder', { defaultValue: '¿A dónde vas?' })}
            value={dropoffAddress || ''}
            mapboxToken={mapboxToken}
            savedLocations={savedLocations}
            predictions={destinationPredictions}
            proximity={mapCenter}
            enrichAddress={enrichWithCrossStreets}
            onSelect={(r) => {
              const loc = { label: r.place_name, address: r.address, latitude: r.latitude, longitude: r.longitude };
              handleSetDropoff(loc);
            }}
            onClear={() => {
              setDropoff(null);
              setDropoffAddress(null);
              setSelectionStep('dropoff');
              setEstimate(null);
              // Same as pickup's onClear: selectedEstimate derives from
              // allEstimates, so the stale card survived the clear.
              setAllEstimates({});
              setRouteCoords(null);
              setRouteInfo(null);
            }}
          />
        </div>

        {/* Destination predictions now render as a tier inside the dropoff
            AddressAutocomplete dropdown (predictions prop), like the client. */}

        {/* ═══ MAP ═══ */}
        <BookingMap
          pickup={pickup}
          dropoff={dropoff}
          userLocation={userLocation}
          onSetPickup={handleSetPickup}
          onSetDropoff={handleSetDropoff}
          onRequestLocation={handleUseMyLocation}
          locationLoading={geoLoading}
          locationError={geoError}
          selectionStep={selectionStep}
          pickupAddress={pickupAddress}
          dropoffAddress={dropoffAddress}
          routeCoords={routeCoords}
          routeLoading={routeLoading}
          nearbyVehicles={nearbyVehicles}
          selectedServiceType={serviceType}
          onMapCenterChange={setMapCenter}
          centerAddress={centerAddress}
          centerAddressLoading={centerAddressLoading}
          onConfirmLocation={handleConfirmLocation}
          flyToTarget={flyToTarget}
        />

        {/* ═══ Reset button ═══ */}
          <button
            type="button"
            onClick={handleResetMap}
            disabled={!pickup && !dropoff}
            aria-label="Reiniciar seleccion de mapa"
            style={{
              width: '100%',
              marginTop: '0.5rem',
              padding: '0.5rem',
              borderRadius: '0.5rem',
              border: '1px solid var(--border)',
              background: 'var(--bg-card)',
              cursor: pickup || dropoff ? 'pointer' : 'not-allowed',
              fontSize: '0.8rem',
              color: 'var(--text-secondary)',
              opacity: pickup || dropoff ? 1 : 0.3,
            }}
          >
            {t('book.map_reset')}
          </button>

        {/* ═══ Selected locations summary ═══ */}
        {(pickup || dropoff) && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
              marginTop: '1rem',
            }}
          >
            {pickup && (
              <div
                style={{
                  padding: '0.5rem 0.75rem',
                  borderRadius: '0.5rem',
                  background: 'rgba(34,197,94,0.12)',
                  border: '1px solid rgba(34,197,94,0.3)',
                  fontSize: '0.85rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: 'var(--success)',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontWeight: 600 }}>{t('book.map_pickup_label')}:</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{pickup.label}</span>
                </div>
                {pickupAddress && (
                  <p style={{ margin: '0.25rem 0 0 1.375rem', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                    {pickupAddress}
                  </p>
                )}
              </div>
            )}
            {dropoff && (
              <div
                style={{
                  padding: '0.5rem 0.75rem',
                  borderRadius: '0.5rem',
                  background: 'rgba(239,68,68,0.12)',
                  border: '1px solid rgba(239,68,68,0.3)',
                  fontSize: '0.85rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: 'var(--error)',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontWeight: 600 }}>{t('book.map_dropoff_label')}:</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{dropoff.label}</span>
                </div>
                {dropoffAddress && (
                  <p style={{ margin: '0.25rem 0 0 1.375rem', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                    {dropoffAddress}
                  </p>
                )}
              </div>
            )}
            {/* ═══ Waypoints (W1.1) ═══ */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', opacity: pickup && dropoff ? 1 : 0.4, pointerEvents: pickup && dropoff ? 'auto' : 'none' }}>
                {waypoints.map((wp, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '0.5rem 0.75rem',
                      borderRadius: '0.5rem',
                      background: 'rgba(245,158,11,0.12)',
                      border: '1px solid rgba(245,158,11,0.3)',
                      fontSize: '0.85rem',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          background: '#f59e0b',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontWeight: 600 }}>Parada {idx + 1}:</span>
                      <span style={{ color: 'var(--text-secondary)' }}>{wp.label}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setWaypoints((prev) => prev.filter((_, i) => i !== idx)); setAllEstimates({}); }}
                      aria-label={`Eliminar parada ${idx + 1}`}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--error)',
                        fontSize: '1rem',
                        fontWeight: 700,
                        padding: '0 0.25rem',
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {waypoints.length < 3 && !addingWaypoint && (
                  <button
                    type="button"
                    onClick={() => setAddingWaypoint(true)}
                    style={{
                      padding: '0.5rem 0.75rem',
                      borderRadius: '0.5rem',
                      border: '1px dashed var(--border)',
                      background: 'var(--bg-card)',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      color: 'var(--text-secondary)',
                      fontWeight: 600,
                    }}
                  >
                    + {t('book.add_stop', { defaultValue: 'Agregar parada' })} ({waypoints.length}/3)
                  </button>
                )}
                {addingWaypoint && (
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <AddressAutocomplete
                        label={t('book.stop_address', { defaultValue: 'Parada' })}
                        placeholder={t('book.stop_placeholder', { defaultValue: 'Dirección de la parada' })}
                        mapboxToken={mapboxToken}
                        proximity={mapCenter}
                        enrichAddress={enrichWithCrossStreets}
                        savedLocations={savedLocations}
                        onSelect={(r) => {
                          setWaypoints((prev) => [
                            ...prev,
                            { label: r.place_name, address: r.address, latitude: r.latitude, longitude: r.longitude },
                          ]);
                          // Invalidate the fares so the auto-estimate effect
                          // recomputes them over the multi-stop route.
                          setAllEstimates({});
                          setAddingWaypoint(false);
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setAddingWaypoint(false)}
                      style={{
                        marginTop: 28,
                        padding: '0.5rem',
                        borderRadius: '0.5rem',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-card)',
                        cursor: 'pointer',
                        fontSize: '0.85rem',
                        color: 'var(--text-tertiary)',
                      }}
                      aria-label={t('common.cancel', { defaultValue: 'Cancelar' })}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>

            {routeInfo && (
              <div
                style={{
                  padding: '0.5rem 0.75rem',
                  borderRadius: '0.5rem',
                  background: 'var(--bg-accent, rgba(255,77,0,0.05))',
                  border: '1px solid var(--primary)',
                  fontSize: '0.8rem',
                  color: 'var(--primary)',
                  fontWeight: 600,
                  textAlign: 'center',
                }}
              >
                {t('book.route_info', {
                  distance: (routeInfo.distance_m / 1000).toFixed(1),
                  duration: Math.round(routeInfo.duration_s / 60),
                })}
              </div>
            )}
          </div>
        )}

        <div
          style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.5rem' }}
        >
          {/* ═══ Service cards with prices ═══ */}
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                {t('book.choose_service', { defaultValue: 'Elige tu servicio' })}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', opacity: pickup && dropoff ? 1 : 0.5, pointerEvents: pickup && dropoff ? 'auto' : 'none' }}>
                {SERVICE_TYPE_KEYS.map((svc) => {
                  const isMensajeria = svc.slug === 'mensajeria';
                  const est = isMensajeria ? allEstimates[deliveryVehicle] : allEstimates[svc.slug];
                  const isSelected = serviceType === svc.slug;
                  const isLoading = estimateLoading && !est;
                  const vt = serviceTypeToVehicleType(svc.slug) as VehicleType | null;
                  const pickupEta = vt ? etaByType[vt] : null;

                  return (
                    <button
                      key={svc.slug}
                      type="button"
                      onClick={() => setServiceType(svc.slug)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '0.85rem 1rem',
                        borderRadius: 12,
                        border: isSelected ? '2px solid var(--primary)' : '1px solid var(--border)',
                        background: isSelected ? 'rgba(var(--primary-rgb, 255,77,0), 0.06)' : 'var(--card-bg)',
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        textAlign: 'left',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <img
                          src={svc.icon}
                          alt={svc.label}
                          style={{ width: 40, height: 40, objectFit: 'contain' }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                            {svc.label}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: 2 }}>
                            {isMensajeria ? 'Según vehículo' : svc.desc}
                            {pickupEta != null && (
                              <span style={{ color: '#16a34a', fontWeight: 600, marginLeft: 6 }}>
                                · {pickupEta} min
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {isLoading ? (
                          <div style={{ width: 60, height: 14, borderRadius: 4, background: 'var(--border-light)', animation: 'pulse 1.5s ease-in-out infinite' }} />
                        ) : est ? (
                          <>
                            <div style={{ fontWeight: 700, fontSize: '1rem', color: isSelected ? 'var(--primary)' : 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.25rem' }}>
                              {paymentMethod === 'tricicoin' && <img src="/images/coins/tricoin-small.png" alt="TRC" style={{ width: 32, height: 32 }} />}
                              {formatPrice(est.estimated_fare_cup, est.estimated_fare_trc)}
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
                              ~{Math.ceil((est.estimated_duration_s || 0) / 60)} min viaje
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>{'\u2014'}</div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>


          {/* ═══ Delivery form (when mensajeria selected) ═══ */}
          {serviceType === 'mensajeria' && (() => {
            const nameEmpty = !deliveryDetails.recipient_name.trim();
            const phoneEmpty = !deliveryDetails.recipient_phone.trim();
            const phoneInvalid = deliveryDetails.recipient_phone.trim().length > 0 && !isValidRecipientPhone(deliveryDetails.recipient_phone);
            const inputBase = {
              width: '100%', padding: '0.6rem 0.75rem', borderRadius: '0.6rem',
              fontSize: '0.85rem', boxSizing: 'border-box' as const, marginTop: '0.25rem',
              outline: 'none', transition: 'border-color 0.15s',
            };
            const labelStyle = { fontSize: '0.75rem', fontWeight: 600 as const, color: 'var(--text-secondary)', letterSpacing: '0.02em' };
            const CATS = [
              { value: 'documentos', icon: '📄', label: t('book.delivery_cat_documentos', { defaultValue: 'Documentos' }) },
              { value: 'comida', icon: '🍔', label: t('book.delivery_cat_comida', { defaultValue: 'Comida' }) },
              { value: 'paquete_pequeno', icon: '📦', label: t('book.delivery_cat_paquete_pequeno', { defaultValue: 'Pequeño' }) },
              { value: 'paquete_grande', icon: '📫', label: t('book.delivery_cat_paquete_grande', { defaultValue: 'Grande' }) },
              { value: 'fragil', icon: '⚠️', label: t('book.delivery_cat_fragil', { defaultValue: 'Frágil' }) },
            ];
            return (
            <div style={{
              marginBottom: '1rem', padding: '1.25rem', borderRadius: '0.85rem',
              border: '2px solid var(--primary)', background: 'linear-gradient(135deg, rgba(255,77,0,0.03) 0%, rgba(255,77,0,0.08) 100%)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                <span style={{ fontSize: '1.25rem' }}>📦</span>
                <div>
                  <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>{t('book.delivery_title', { defaultValue: 'Datos del envío' })}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>{t('book.delivery_subtitle', { defaultValue: 'Completa los datos del destinatario' })}</div>
                </div>
              </div>
              {/* Vehicle selector for delivery */}
              <div style={{ marginBottom: '0.75rem' }}>
                <label style={labelStyle}>{t('book.delivery_choose_vehicle', { defaultValue: 'Vehículo para el envío' })} *</label>
                <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.35rem', flexWrap: 'wrap' }}>
                  {([
                    { slug: 'moto_standard' as ServiceTypeSlug, icon: '/images/vehicles/moto.png', label: 'Moto' },
                    { slug: 'triciclo_basico' as ServiceTypeSlug, icon: '/images/vehicles/triciclo.png', label: 'Triciclo' },
                    { slug: 'auto_standard' as ServiceTypeSlug, icon: '/images/vehicles/auto.png', label: 'Auto' },
                    { slug: 'auto_confort' as ServiceTypeSlug, icon: '/images/vehicles/confort.png', label: 'Confort' },
                  ]).map(v => {
                    const vEst = allEstimates[v.slug];
                    return (
                    <button key={v.slug} type="button"
                      onClick={() => setDeliveryVehicle(v.slug)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '0.35rem',
                        padding: '0.45rem 0.7rem', borderRadius: '0.6rem', fontSize: '0.75rem', fontWeight: 600,
                        border: deliveryVehicle === v.slug ? '2px solid var(--primary)' : '1px solid var(--border)',
                        background: deliveryVehicle === v.slug ? 'rgba(255,77,0,0.08)' : 'var(--bg-card)',
                        color: deliveryVehicle === v.slug ? 'var(--primary)' : 'var(--text-secondary)',
                        cursor: 'pointer', transition: 'all 0.15s',
                      }}
                    >
                      <img src={v.icon} alt={v.label} style={{ width: 22, height: 22, objectFit: 'contain' }} />
                      {v.label}
                      {vEst && <span style={{ fontSize: '0.65rem', opacity: 0.8 }}>{formatPrice(vEst.estimated_fare_cup, vEst.estimated_fare_trc)}</span>}
                    </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {/* Recipient row */}
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <div style={{ flex: 1 }}>
                    <label style={labelStyle}>{t('book.delivery_recipient_name', { defaultValue: 'Destinatario' })} *</label>
                    <input type="text" value={deliveryDetails.recipient_name}
                      onChange={(e) => setDeliveryDetails(d => ({ ...d, recipient_name: e.target.value }))}
                      placeholder={t('book.delivery_recipient_name_ph', { defaultValue: 'Nombre completo' })}
                      style={{ ...inputBase, border: nameEmpty && deliveryDetails.recipient_phone ? '2px solid #ef4444' : '1px solid var(--border)' }}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={labelStyle}>{t('book.delivery_recipient_phone', { defaultValue: 'Teléfono' })} *</label>
                    <input type="tel" value={deliveryDetails.recipient_phone}
                      onChange={(e) => setDeliveryDetails(d => ({ ...d, recipient_phone: e.target.value }))}
                      placeholder="+53 5XXXXXXX"
                      style={{ ...inputBase, border: phoneInvalid ? '2px solid #ef4444' : '1px solid var(--border)' }}
                    />
                    {phoneInvalid && <span style={{ fontSize: '0.65rem', color: '#ef4444' }}>{t('book.delivery_phone_invalid', { defaultValue: 'Número inválido' })}</span>}
                  </div>
                </div>
                {/* Package category chips */}
                <div>
                  <label style={labelStyle}>{t('book.delivery_category', { defaultValue: 'Tipo de paquete' })}</label>
                  <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.35rem', flexWrap: 'wrap' }}>
                    {CATS.map(c => (
                      <button key={c.value} type="button"
                        onClick={() => setDeliveryDetails(d => ({ ...d, package_category: c.value }))}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '0.3rem',
                          padding: '0.4rem 0.7rem', borderRadius: '2rem', fontSize: '0.75rem', fontWeight: 600,
                          border: deliveryDetails.package_category === c.value ? '2px solid var(--primary)' : '1px solid var(--border)',
                          background: deliveryDetails.package_category === c.value ? 'rgba(255,77,0,0.08)' : 'var(--bg-card)',
                          color: deliveryDetails.package_category === c.value ? 'var(--primary)' : 'var(--text-secondary)',
                          cursor: 'pointer', transition: 'all 0.15s',
                        }}
                      >{c.icon} {c.label}</button>
                    ))}
                  </div>
                </div>
                {/* Description + Weight row */}
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <div style={{ flex: 2 }}>
                    <label style={labelStyle}>{t('book.delivery_description', { defaultValue: 'Descripción' })}</label>
                    <input type="text" value={deliveryDetails.package_description}
                      onChange={(e) => setDeliveryDetails(d => ({ ...d, package_description: e.target.value }))}
                      placeholder={t('book.delivery_description_ph', { defaultValue: '¿Qué envías?' })}
                      style={{ ...inputBase, border: '1px solid var(--border)' }}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={labelStyle}>{t('book.delivery_weight', { defaultValue: 'Peso (kg)' })}</label>
                    <input type="number" value={deliveryDetails.estimated_weight_kg}
                      onChange={(e) => setDeliveryDetails(d => ({ ...d, estimated_weight_kg: e.target.value }))}
                      placeholder="0.5" min="0.1" step="0.1"
                      style={{ ...inputBase, border: '1px solid var(--border)' }}
                    />
                  </div>
                </div>
                {/* Package dimensions (cm) — optional */}
                <div>
                  <label style={labelStyle}>{t('book.delivery_dimensions', { defaultValue: 'Dimensiones (cm) — opcional' })}</label>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                    <input type="number" value={deliveryDetails.package_length_cm}
                      onChange={(e) => setDeliveryDetails(d => ({ ...d, package_length_cm: e.target.value }))}
                      placeholder="Largo" min="1" step="1" aria-label="Largo en cm"
                      style={{ ...inputBase, marginTop: 0, border: '1px solid var(--border)' }}
                    />
                    <input type="number" value={deliveryDetails.package_width_cm}
                      onChange={(e) => setDeliveryDetails(d => ({ ...d, package_width_cm: e.target.value }))}
                      placeholder="Ancho" min="1" step="1" aria-label="Ancho en cm"
                      style={{ ...inputBase, marginTop: 0, border: '1px solid var(--border)' }}
                    />
                    <input type="number" value={deliveryDetails.package_height_cm}
                      onChange={(e) => setDeliveryDetails(d => ({ ...d, package_height_cm: e.target.value }))}
                      placeholder="Alto" min="1" step="1" aria-label="Alto en cm"
                      style={{ ...inputBase, marginTop: 0, border: '1px solid var(--border)' }}
                    />
                  </div>
                </div>
                {/* Instructions */}
                <div>
                  <label style={labelStyle}>Instrucciones especiales</label>
                  <input type="text" value={deliveryDetails.special_instructions}
                    onChange={(e) => setDeliveryDetails(d => ({ ...d, special_instructions: e.target.value }))}
                    placeholder="Ej: Tocar timbre, preguntar por Juan..."
                    style={{ ...inputBase, border: '1px solid var(--border)' }}
                  />
                </div>
                {/* Client accompanies toggle */}
                <button type="button"
                  onClick={() => setDeliveryDetails(d => ({ ...d, client_accompanies: !d.client_accompanies }))}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.75rem',
                    padding: '0.75rem', borderRadius: '0.75rem', width: '100%',
                    border: deliveryDetails.client_accompanies ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: deliveryDetails.client_accompanies ? 'rgba(255,77,0,0.06)' : 'var(--bg-card)',
                    cursor: 'pointer', transition: 'all 0.15s', textAlign: 'left',
                  }}
                >
                  <div style={{
                    width: 40, height: 22, borderRadius: 11, position: 'relative',
                    background: deliveryDetails.client_accompanies ? 'var(--primary)' : 'var(--border)',
                    transition: 'background 0.2s', flexShrink: 0,
                  }}>
                    <div style={{
                      width: 18, height: 18, borderRadius: '50%', background: 'white',
                      position: 'absolute', top: 2,
                      left: deliveryDetails.client_accompanies ? 20 : 2,
                      transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                    }} />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                      Voy con el envio
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
                      Acompana tu paquete sin costo adicional
                    </div>
                  </div>
                </button>
              </div>
            </div>
            );
          })()}

          {/* ═══ Error message ═══ */}
          {error && (
            <p
              style={{
                color: 'var(--primary-dark)',
                fontSize: '0.875rem',
                textAlign: 'center',
              }}
            >
              {error}
            </p>
          )}

          {/* ═══ Fare estimate card ═══ */}
            <div
              className="booking-estimate-card"
              style={{
                padding: '1.25rem',
                borderRadius: '0.75rem',
                border: selectedEstimate ? '2px solid var(--primary)' : '1px solid var(--border)',
                background: selectedEstimate ? 'var(--bg-accent, rgba(255,77,0,0.05))' : 'var(--card-bg)',
                opacity: selectedEstimate ? 1 : 0.6,
              }}
            >
              {!selectedEstimate && (
                <div style={{ textAlign: 'center', padding: '0.5rem 0', fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>
                  Selecciona origen y destino para ver el estimado
                </div>
              )}
              {selectedEstimate && (
              <>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.75rem',
                }}
              >
                <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                  {t('book.estimated_fare')}
                </span>
                <div style={{ textAlign: 'right' }}>
                  {promoResult?.valid && promoResult.discount > 0 ? (
                    <>
                      <span style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-tertiary)', textDecoration: 'line-through', marginRight: '0.5rem' }}>
                        {formatPrice(selectedEstimate?.estimated_fare_cup ?? 0, selectedEstimate?.estimated_fare_trc)}
                      </span>
                      <span style={{ fontSize: '1.5rem', fontWeight: 800, color: '#22c55e', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        {paymentMethod === 'tricicoin' && <img src="/images/coins/tricoin-small.png" alt="TRC" style={{ width: 36, height: 36 }} />}
                        {/* displayFareCup already subtracts promo AND shared-ride
                            discount, matching the Solicitar button (was promo-only). */}
                        {formatPrice(displayFareCup)}
                      </span>
                    </>
                  ) : (
                    <span style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      {paymentMethod === 'tricicoin' && <img src="/images/coins/tricoin-small.png" alt="TRC" style={{ width: 36, height: 36 }} />}
                      {/* displayFareCup/Trc subtract the shared-ride discount so
                          the headline reconciles with the Solicitar button. */}
                      {formatPrice(displayFareCup, displayFareTrc)}
                    </span>
                  )}
                </div>
              </div>
              <div
                className="booking-fare-details"
                style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem', color: 'var(--text-secondary)', flexWrap: 'wrap' }}
              >
                <span>{((selectedEstimate?.estimated_distance_m ?? 0) / 1000).toFixed(1)} km</span>
                <span>{Math.round((selectedEstimate?.estimated_duration_s ?? 0) / 60)} min</span>
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {/* Live rate from the estimate (exchange_rates table) — the
                      old hardcoded ÷300 contradicted the "1 USD = X CUP" line
                      printed below (real rate ~640). */}
                  ~${((selectedEstimate?.estimated_fare_cup ?? 0) / (selectedEstimate?.exchange_rate_usd_cup || 300)).toFixed(2)} USD
                </span>
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {'\u2248'} {formatPrice(selectedEstimate?.estimated_fare_cup ?? 0, selectedEstimate?.estimated_fare_trc)}
                </span>
                {(selectedEstimate?.surge_multiplier ?? 0) > 1 && (
                  <span
                    style={{
                      color: 'white',
                      background: 'var(--primary)',
                      fontWeight: 700,
                      padding: '0.125rem 0.5rem',
                      borderRadius: '1rem',
                      fontSize: '0.7rem',
                    }}
                  >
                    {(selectedEstimate?.surge_multiplier ?? 0).toFixed(1)}x {t('book.surge_active', { defaultValue: 'mal tiempo' })}
                  </span>
                )}
              </div>
              {(selectedEstimate?.per_km_rate_cup ?? 0) > 0 && (
                <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                  {t('book.per_km_rate', {
                    rate: formatPrice(selectedEstimate?.per_km_rate_cup ?? 0),
                  })}
                </p>
              )}
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
                1 USD = {selectedEstimate?.exchange_rate_usd_cup ?? 0} CUP
              </p>

              {/* Corporate account selector */}
              {corporateAccounts.length > 0 && (
                <div style={{ marginTop: '1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                    {t('book.charge_to', { defaultValue: 'Cobrar a' })}
                  </label>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => { setSelectedCorporateId(null); setPaymentMethod('cash'); }}
                      aria-pressed={!selectedCorporateId}
                      style={{
                        flex: 1, minWidth: 80, padding: '0.5rem 0.75rem', borderRadius: '0.5rem',
                        border: !selectedCorporateId ? '2px solid var(--primary)' : '1px solid var(--border)',
                        background: !selectedCorporateId ? 'var(--primary-alpha-10)' : 'var(--bg-card)',
                        cursor: 'pointer', fontSize: '0.8rem', fontWeight: !selectedCorporateId ? 700 : 400,
                      }}
                    >
                      {t('book.personal', { defaultValue: 'Personal' })}
                    </button>
                    {corporateAccounts.map((acc) => {
                      const isSelected = selectedCorporateId === acc.id;
                      const remaining = acc.monthly_budget_trc > 0 ? acc.monthly_budget_trc - acc.current_month_spent : null;
                      return (
                        <button
                          key={acc.id}
                          type="button"
                          onClick={() => { setSelectedCorporateId(acc.id); setPaymentMethod('corporate' as PaymentMethod); }}
                          aria-pressed={isSelected}
                          style={{
                            flex: 1, minWidth: 80, padding: '0.5rem 0.75rem', borderRadius: '0.5rem',
                            border: isSelected ? '2px solid var(--primary)' : '1px solid var(--border)',
                            background: isSelected ? 'var(--primary-alpha-10)' : 'var(--bg-card)',
                            cursor: 'pointer', fontSize: '0.8rem', fontWeight: isSelected ? 700 : 400,
                            textAlign: 'center',
                          }}
                        >
                          <span style={{ display: 'block' }}>{acc.name}</span>
                          {remaining !== null && (
                            <span style={{ display: 'block', fontSize: '0.65rem', color: isSelected ? 'var(--primary)' : 'var(--text-tertiary)', marginTop: 2 }}>
                              {formatTRC(remaining)} {t('book.remaining', { defaultValue: 'disp.' })}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {selectedCorporateId && (
                    <div style={{ marginTop: '0.5rem', background: 'var(--primary-alpha-10)', borderRadius: '0.5rem', padding: '0.5rem 0.75rem' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--primary)', fontWeight: 500 }}>
                        {t('book.riding_as_corporate', {
                          defaultValue: 'Viaje a cargo de {{company}}',
                          company: corporateAccounts.find((a) => a.id === selectedCorporateId)?.name ?? '',
                        })}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Payment method — hidden when corporate selected */}
              {!selectedCorporateId && (
              <div style={{ marginTop: '1rem' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    marginBottom: '0.5rem',
                  }}
                >
                  {t('book.payment_method')}
                </label>
                <div className="booking-payment-methods" style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('cash')}
                    aria-label="Pagar en efectivo"
                    aria-pressed={paymentMethod === 'cash'}
                    style={{
                      flex: 1,
                      padding: '0.5rem',
                      borderRadius: '0.5rem',
                      border:
                        paymentMethod === 'cash'
                          ? '2px solid var(--primary)'
                          : '1px solid var(--border)',
                      background: paymentMethod === 'cash' ? 'var(--primary-alpha-10)' : 'var(--bg-card)',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      fontWeight: paymentMethod === 'cash' ? 700 : 400,
                    }}
                  >
                    {t('book.payment_cash')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('tricicoin')}
                    aria-label="Pagar con TriciCoin"
                    aria-pressed={paymentMethod === 'tricicoin'}
                    style={{
                      flex: 1,
                      padding: '0.5rem',
                      borderRadius: '0.5rem',
                      border:
                        paymentMethod === 'tricicoin'
                          ? '2px solid var(--primary)'
                          : '1px solid var(--border)',
                      background: paymentMethod === 'tricicoin' ? 'var(--primary-alpha-10)' : 'var(--bg-card)',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      fontWeight: paymentMethod === 'tricicoin' ? 700 : 400,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.35rem',
                    }}
                  >
                    <img src="/images/coins/tricoin-small.png" alt="" style={{ width: 32, height: 32 }} />
                    {t('book.payment_tricicoin')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('mixed' as PaymentMethod)}
                    aria-label="Pago mixto"
                    aria-pressed={paymentMethod === 'mixed'}
                    style={{
                      flex: 1,
                      padding: '0.5rem',
                      borderRadius: '0.5rem',
                      border:
                        paymentMethod === 'mixed'
                          ? '2px solid var(--primary)'
                          : '1px solid var(--border)',
                      background: paymentMethod === 'mixed' ? 'var(--primary-alpha-10)' : 'var(--bg-card)',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      fontWeight: paymentMethod === 'mixed' ? 700 : 400,
                    }}
                  >
                    {t('book.payment_mixed', { defaultValue: 'Mixto' })}
                  </button>
                </div>
                {/* Mixed payment slider */}
                {paymentMethod === 'mixed' && selectedEstimate && (
                  <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: 'var(--bg-light)', borderRadius: '0.5rem' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>
                      {t('book.wallet_percentage', { defaultValue: 'Porcentaje desde wallet' })}
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={Math.round(walletRatio * 100)}
                      onChange={(e) => {
                        const maxRatio = walletBalance > 0 && selectedEstimate.estimated_fare_cup > 0
                          ? Math.min(1, walletBalance / selectedEstimate.estimated_fare_cup)
                          : 0;
                        const raw = parseInt(e.target.value, 10) / 100;
                        setWalletRatio(Math.min(raw, maxRatio));
                      }}
                      style={{ width: '100%', accentColor: 'var(--primary)' }}
                    />
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textAlign: 'center', margin: '0.35rem 0 0' }}>
                      {(() => {
                        const totalFare = selectedEstimate.estimated_fare_cup;
                        const walletPart = Math.round(totalFare * walletRatio);
                        const cashPart = totalFare - walletPart;
                        return t('book.mixed_breakdown', {
                          defaultValue: `${formatCUP(walletPart)} billetera + ${formatCUP(cashPart)} efectivo = ${formatCUP(totalFare)} total`,
                          wallet: formatCUP(walletPart),
                          cash: formatCUP(cashPart),
                          total: formatCUP(totalFare),
                        });
                      })()}
                    </p>
                  </div>
                )}
              </div>
              )}
              </>
              )}
            </div>

          {/* ═══ Promo code (W1.3) ═══ */}
          <div style={{ marginTop: '0.75rem' }}>
            <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
              {t('book.promo_question', { defaultValue: 'Código promocional' })}
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
              <input
                type="text"
                value={promoCode}
                onChange={(e) => { setPromoCode(e.target.value.toUpperCase()); setPromoResult(null); }}
                placeholder={t('book.promo_placeholder', { defaultValue: 'Ingresa tu código' })}
                aria-label={t('book.promo_question', { defaultValue: 'Código promocional' })}
                disabled={promoResult?.valid === true}
                style={{
                  flex: 1,
                  padding: '0.5rem',
                  borderRadius: '0.5rem',
                  border: promoResult?.valid ? '2px solid #22c55e' : promoResult?.valid === false ? '2px solid #ef4444' : '1px solid var(--border)',
                  background: promoResult?.valid ? 'rgba(34,197,94,0.05)' : 'var(--bg-card)',
                  fontSize: '0.85rem',
                  boxSizing: 'border-box',
                }}
              />
              {promoResult?.valid ? (
                <button
                  type="button"
                  onClick={() => { setPromoCode(''); setPromoResult(null); }}
                  style={{
                    padding: '0.5rem 0.75rem',
                    borderRadius: '0.5rem',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-card)',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    color: 'var(--text-secondary)',
                  }}
                >
                  Quitar
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleApplyPromo}
                  disabled={!promoCode.trim() || !selectedEstimate || promoValidating}
                  style={{
                    padding: '0.5rem 1rem',
                    borderRadius: '0.5rem',
                    border: 'none',
                    background: !promoCode.trim() || !selectedEstimate || promoValidating ? '#ccc' : 'var(--primary)',
                    color: 'white',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    cursor: !promoCode.trim() || !selectedEstimate || promoValidating ? 'not-allowed' : 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {promoValidating ? 'Validando...' : 'Aplicar'}
                </button>
              )}
            </div>
            {promoResult && (
              <p style={{ fontSize: '0.75rem', marginTop: '0.25rem', color: promoResult.valid ? '#22c55e' : '#ef4444' }}>
                {promoResult.valid
                  ? `Descuento aplicado: -${formatPrice(promoResult.discount)}`
                  : promoResult.error}
              </p>
            )}
          </div>

          {/* ═══ Trip options — parity con app móvil ═══ */}
          {selectedEstimate && (() => {
            // Use the component-level shared-ride values (single source of truth,
            // also read by the confirm-button price below).
            const shareOcc = shareOccSeats;
            const sectionLabel = { fontSize: '0.85rem', fontWeight: 600 as const, color: 'var(--text-secondary)' };
            const rowStyle = (active: boolean) => ({
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '0.75rem', borderRadius: '0.6rem', width: '100%', textAlign: 'left' as const,
              border: active ? '2px solid var(--primary)' : '1px solid var(--border)',
              background: active ? 'rgba(255,77,0,0.06)' : 'var(--bg-card)', cursor: 'pointer',
            });
            const stepBtn = {
              width: 32, height: 32, borderRadius: 16, border: '1px solid var(--border)',
              background: 'var(--bg-card)', cursor: 'pointer', fontSize: '1.1rem', fontWeight: 700,
              color: 'var(--text-secondary)', lineHeight: 1,
            };
            const Toggle = ({ on }: { on: boolean }) => (
              <div style={{ width: 40, height: 22, borderRadius: 11, position: 'relative', flexShrink: 0, background: on ? 'var(--primary)' : 'var(--border)', transition: 'background 0.2s' }}>
                <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: on ? 20 : 2, transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
              </div>
            );
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem' }}>
                {/* Compartir viaje (solo triciclo) */}
                {serviceType === 'triciclo_basico' && (
                  <div>
                    <button type="button" onClick={() => setShareRide((v) => !v)} aria-pressed={shareRide} style={rowStyle(shareRide)}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <span style={{ fontSize: '1.1rem' }}>👥</span>
                        <div>
                          <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {t('book.share_ride', { defaultValue: 'Compartir viaje' })}
                          </div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>
                            {shareRide && shareFreeSeats > 0
                              ? t('book.share_ride_savings', { defaultValue: `Ahorras ${formatCUP(shareDiscountCup)} · ${shareFreeSeats} asiento(s) libre(s)` })
                              : t('book.share_ride_desc', { defaultValue: 'El conductor puede recoger otros pasajeros' })}
                          </div>
                        </div>
                      </div>
                      <Toggle on={shareRide} />
                    </button>
                    {shareRide && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.5rem', padding: '0 0.25rem' }}>
                        <span style={sectionLabel}>{t('book.seats_you_use', { defaultValue: 'Asientos que ocupas' })}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <button type="button" onClick={() => setPassengerCount(Math.max(1, passengerCount - 1))} aria-label="Menos asientos" style={stepBtn}>−</button>
                          <span style={{ minWidth: 20, textAlign: 'center', fontWeight: 700 }}>{shareOcc}</span>
                          <button type="button" onClick={() => setPassengerCount(Math.min(3, passengerCount + 1))} aria-label="Más asientos" style={stepBtn}>+</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Preferencias de viaje (espejo del chip móvil — index.tsx).
                    Las preferencias se editan en /profile/ride-preferences y
                    se envían como rider_preferences en createRide. */}
                {ridePreferencesEnabled && (() => {
                  const hasActive = Object.values(ridePrefs).some(Boolean);
                  const pillStyle = {
                    fontSize: '0.68rem', fontWeight: 600 as const, color: 'var(--primary)',
                    background: 'rgba(255,77,0,0.12)', padding: '0.15rem 0.5rem', borderRadius: '999px',
                  };
                  return (
                    <Link
                      href="/profile/ride-preferences"
                      aria-label={t('book.preferences_button', { defaultValue: 'Preferencias de viaje' })}
                      style={{ ...rowStyle(hasActive), textDecoration: 'none' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flex: 1 }}>
                        <span aria-hidden="true" style={{ fontSize: '1.1rem' }}>🎚️</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {t('book.preferences_button', { defaultValue: 'Preferencias de viaje' })}
                          </div>
                          {hasActive ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.3rem' }}>
                              {ridePrefs.quiet_mode && (
                                <span style={pillStyle}>{t('book.pref_quiet', { defaultValue: 'Silencio' })}</span>
                              )}
                              {ridePrefs.temperature === 'cool' && (
                                <span style={pillStyle}>{t('book.pref_cool', { defaultValue: 'AC fresco' })}</span>
                              )}
                              {ridePrefs.temperature === 'warm' && (
                                <span style={pillStyle}>{t('book.pref_warm', { defaultValue: 'Cálido' })}</span>
                              )}
                              {ridePrefs.conversation_ok && (
                                <span style={pillStyle}>{t('book.pref_conversation', { defaultValue: 'Conversación' })}</span>
                              )}
                              {ridePrefs.luggage_trunk && (
                                <span style={pillStyle}>{t('book.pref_trunk', { defaultValue: 'Maletero' })}</span>
                              )}
                              {(ridePrefs.accessibility_needs?.length ?? 0) > 0 && (
                                <span style={pillStyle}>♿ {ridePrefs.accessibility_needs?.length}</span>
                              )}
                            </div>
                          ) : (
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>
                              {t('book.preferences_hint', { defaultValue: 'Silencio, A/C, equipaje, accesibilidad' })}
                            </div>
                          )}
                        </div>
                      </div>
                      <span aria-hidden="true" style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>›</span>
                    </Link>
                  );
                })()}
              </div>
            );
          })()}

          {/* ═══ Schedule a future ride (parity con app móvil) ═══ */}
          <div style={{ marginTop: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={isScheduled}
                onChange={(e) => { setIsScheduled(e.target.checked); if (!e.target.checked) setScheduleDate(''); }}
              />
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                {t('book.schedule_toggle', { defaultValue: 'Programar viaje' })}
              </span>
            </label>
            {isScheduled && (
              <input
                type="datetime-local"
                value={scheduleDate}
                onChange={(e) => setScheduleDate(e.target.value)}
                min={new Date().toISOString().slice(0, 16)}
                aria-label={t('book.schedule_toggle', { defaultValue: 'Programar viaje' })}
                style={{
                  width: '100%',
                  marginTop: '0.5rem',
                  padding: '0.5rem',
                  borderRadius: '0.5rem',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-page)',
                  color: 'var(--text-primary)',
                  fontSize: '0.85rem',
                  boxSizing: 'border-box',
                }}
              />
            )}
          </div>

          {/* Request button with price */}
            <button
              onClick={handleRequest}
              disabled={isRequesting || !selectedEstimate}
              aria-label="Solicitar viaje ahora"
              style={{
                width: '100%',
                padding: '1rem',
                borderRadius: '0.75rem',
                border: 'none',
                background: !selectedEstimate ? '#ccc' : isRequesting ? '#ccc' : 'var(--primary)',
                color: 'white',
                fontSize: '1rem',
                fontWeight: 700,
                cursor: !selectedEstimate || isRequesting ? 'not-allowed' : 'pointer',
                marginTop: '0.75rem',
              }}
            >
              {isRequesting
                ? t('book.requesting')
                : selectedEstimate
                  ? `${t('book.request_ride', { defaultValue: 'Solicitar' })} ${(SERVICE_TYPE_KEYS.find(s => s.slug === serviceType)?.label || '')} · ${formatPrice(displayFareCup, displayFareTrc)}`
                  : t('book.request_ride', { defaultValue: 'Solicitar viaje' })
              }
            </button>
        </div>

        {/* Home dashboard (parity con el home móvil NativeHomeScreen): re-pedir
            último viaje + promos + anuncios, debajo del formulario de reserva.
            Sólo para usuarios autenticados; se auto-oculta si no hay nada. */}
        {user && (
          <HomeDashboard
            userId={user.id}
            onRebook={(loc) => {
              handleSetDropoff(loc);
              if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        )}

        {/* Spacer for fixed bottom CTA on mobile */}
        <div style={{ height: '5rem' }} className="booking-cta-spacer" />
      </div>

      {/* Fixed bottom CTA on mobile */}
        <div className="booking-cta-fixed">
          <button
            onClick={handleRequest}
            disabled={isRequesting || !selectedEstimate}
            style={{
              width: '100%',
              padding: '1rem',
              borderRadius: '0.75rem',
              border: 'none',
              background: !selectedEstimate ? '#ccc' : isRequesting ? '#ccc' : 'var(--primary)',
              color: 'white',
              fontSize: '1rem',
              fontWeight: 700,
              cursor: !selectedEstimate || isRequesting ? 'not-allowed' : 'pointer',
            }}
          >
            {isRequesting
              ? t('book.requesting')
              : selectedEstimate
                ? `${t('book.request_ride', { defaultValue: 'Solicitar' })} ${(SERVICE_TYPE_KEYS.find(s => s.slug === serviceType)?.label || '')} \u00b7 ${formatPrice(displayFareCup, displayFareTrc)}`
                : t('book.request_ride', { defaultValue: 'Solicitar viaje' })
            }
          </button>
        </div>
    </main>
  );
}
