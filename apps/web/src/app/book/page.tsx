'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';
import { formatTRC, formatTRCasUSD, formatCUP, findNearestPreset, serviceTypeToVehicleType, CUBA_CENTER, deliveryVehicleToSlug, isPackageCompatible, PACKAGE_CATEGORY_LABELS, INCOMPATIBILITY_REASON_LABELS, fetchETAsToPickup } from '@tricigo/utils';
import type { LocationPreset } from '@tricigo/utils';
import type { PackageSpecs, VehicleCargoCapabilities } from '@tricigo/utils';
import { rideService, nearbyService, customerService, deliveryService, getSupabaseClient } from '@tricigo/api';
import type { FareEstimate, ServiceTypeSlug, PaymentMethod, NearbyVehicle, VehicleType, PackageCategory } from '@tricigo/types';
import { PACKAGE_CATEGORIES } from '@tricigo/types';
import { useGeolocation } from '../../hooks/useGeolocation';
import { fetchRoute, reverseGeocode, snapToNearestRoad } from '../../services/geoService';
import { useAuth } from '../providers';
import { AddressAutocomplete } from '@/components/AddressAutocomplete';

/* Dynamic import — Mapbox GL JS requires `window` */
function MapLoadingFallback() {
  const { t } = useTranslation('web');
  return (
    <div
      style={{
        height: 420,
        width: '100%',
        borderRadius: '0.75rem',
        border: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#1a1a2e',
        color: 'var(--text-secondary)',
        fontSize: '0.875rem',
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

const SERVICE_TYPE_KEYS: { slug: ServiceTypeSlug; image: string; labelKey: string; descKey: string }[] = [
  { slug: 'triciclo_basico', image: '/images/vehicles/triciclo.png', labelKey: 'book.service_triciclo', descKey: 'book.service_triciclo_desc' },
  { slug: 'moto_standard', image: '/images/vehicles/moto.png', labelKey: 'book.service_moto', descKey: 'book.service_moto_desc' },
  { slug: 'auto_standard', image: '/images/vehicles/auto.png', labelKey: 'book.service_auto', descKey: 'book.service_auto_desc' },
  { slug: 'auto_confort', image: '/images/vehicles/confort.png', labelKey: 'book.service_confort', descKey: 'book.service_confort_desc' },
  { slug: 'mensajeria', image: '/images/vehicles/mensajeria.png', labelKey: 'book.service_mensajeria', descKey: 'book.service_mensajeria_desc' },
];

type SelectionStep = 'pickup' | 'dropoff' | 'done';

export default function BookPage() {
  const router = useRouter();
  const { t } = useTranslation('web');
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';

  /* ─── Saved locations ─── */
  const [savedLocations, setSavedLocations] = useState<Array<{ label: string; address: string; latitude: number; longitude: number }>>([]);

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
      } catch { /* ignore — saved locations are optional */ }
    }
    loadSaved();
  }, []);

  /* ─── Location state ─── */
  const [pickup, setPickup] = useState<LocationPreset | null>(null);
  const [dropoff, setDropoff] = useState<LocationPreset | null>(null);
  const [selectionStep, setSelectionStep] = useState<SelectionStep>('pickup');
  const [mapCenter, setMapCenter] = useState({ latitude: CUBA_CENTER.latitude, longitude: CUBA_CENTER.longitude });

  /* ─── Ride state ─── */
  const [serviceType, setServiceType] = useState<ServiceTypeSlug>('triciclo_basico');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [allEstimates, setAllEstimates] = useState<Record<string, FareEstimate | null>>({});
  const [estimateLoading, setEstimateLoading] = useState(false);
  const selectedEstimate = allEstimates[serviceType] || null;
  const [showOptions, setShowOptions] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const isRequestingRef = useRef(false);
  const routeTokenRef = useRef(0);
  const pickupRef = useRef<LocationPreset | null>(null);
  const dropoffRef = useRef<LocationPreset | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* ─── Route & address state ─── */
  const [pickupAddress, setPickupAddress] = useState<string | null>(null);
  const [dropoffAddress, setDropoffAddress] = useState<string | null>(null);
  const [routeCoords, setRouteCoords] = useState<[number, number][] | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeInfo, setRouteInfo] = useState<{ distance_m: number; duration_s: number } | null>(null);

  /* ─── Waypoints state (W1.1) ─── */
  const [waypoints, setWaypoints] = useState<LocationPreset[]>([]);
  const [addingWaypoint, setAddingWaypoint] = useState(false);

  /* ─── Scheduled ride state (W1.2) ─── */
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');

  /* ─── Promo code state (W1.3) ─── */
  const [promoCode, setPromoCode] = useState('');

  /* ─── Insurance state (W1.4) ─── */
  const [insuranceSelected, setInsuranceSelected] = useState(false);
  const [insuranceExpanded, setInsuranceExpanded] = useState(false);

  /* ─── Center pin state (F1) ─── */
  const [centerAddress, setCenterAddress] = useState<string | null>(null);
  const [centerAddressLoading, setCenterAddressLoading] = useState(false);
  const [flyToTarget, setFlyToTarget] = useState<{ latitude: number; longitude: number } | null>(null);
  const geocodeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const geocodeAbortRef = useRef<AbortController | null>(null);

  /* ─── Road-snap state (F2) ─── */
  const [snappingToast, setSnappingToast] = useState<string | null>(null);
  const [snappingLoading, setSnappingLoading] = useState(false);

  /* ─── Promo code validation state (F3) ─── */
  const [promoExpanded, setPromoExpanded] = useState(false);
  const [promoValidating, setPromoValidating] = useState(false);
  const [promoResult, setPromoResult] = useState<{
    valid: boolean;
    promoCodeId?: string;
    discountPercent?: number;
    discountFixed?: number;
    error?: string;
  } | null>(null);

  /* ─── Nearby vehicles state ─── */
  const [nearbyVehicles, setNearbyVehicles] = useState<NearbyVehicle[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);
  const realtimeChannelRef = useRef<ReturnType<typeof nearbyService.subscribeToDriverPositions> | null>(null);

  /* ─── Delivery state ─── */
  const [deliveryCategory, setDeliveryCategory] = useState<PackageCategory | null>(null);
  const [deliveryWeight, setDeliveryWeight] = useState('');
  const [deliveryLength, setDeliveryLength] = useState('');
  const [deliveryWidth, setDeliveryWidth] = useState('');
  const [deliveryHeight, setDeliveryHeight] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [clientAccompanies, setClientAccompanies] = useState(false);
  const [specialInstructions, setSpecialInstructions] = useState('');
  const [deliveryVehicleType, setDeliveryVehicleType] = useState<VehicleType | null>(null);
  const [deliveryVehicleCaps, setDeliveryVehicleCaps] = useState<Array<{ type: VehicleType; maxWeightKg: number | null; maxLengthCm: number | null; maxWidthCm: number | null; maxHeightCm: number | null; acceptedCategories: PackageCategory[]; availableCount: number }>>([]);
  const [deliveryCapsLoading, setDeliveryCapsLoading] = useState(false);

  /* ─── Fetch delivery vehicle capabilities when mensajeria selected ─── */
  useEffect(() => {
    if (serviceType !== 'mensajeria') return;
    let cancelled = false;
    setDeliveryCapsLoading(true);

    async function fetchDeliveryCaps() {
      try {
        const supabase = getSupabaseClient();
        const { data } = await supabase
          .from('vehicles')
          .select('type, max_cargo_weight_kg, max_cargo_length_cm, max_cargo_width_cm, max_cargo_height_cm, accepted_cargo_categories')
          .eq('accepts_cargo', true)
          .eq('is_active', true);

        if (cancelled) return;

        const byType = new Map<VehicleType, typeof deliveryVehicleCaps[number]>();
        for (const v of data ?? []) {
          const existing = byType.get(v.type as VehicleType);
          if (!existing) {
            byType.set(v.type as VehicleType, {
              type: v.type as VehicleType,
              maxWeightKg: v.max_cargo_weight_kg ?? null,
              maxLengthCm: v.max_cargo_length_cm ?? null,
              maxWidthCm: v.max_cargo_width_cm ?? null,
              maxHeightCm: v.max_cargo_height_cm ?? null,
              acceptedCategories: (v.accepted_cargo_categories as PackageCategory[]) ?? [],
              availableCount: 1,
            });
          } else {
            existing.availableCount += 1;
            if (v.max_cargo_weight_kg != null) existing.maxWeightKg = Math.max(existing.maxWeightKg ?? 0, v.max_cargo_weight_kg);
            if (v.max_cargo_length_cm != null) existing.maxLengthCm = Math.max(existing.maxLengthCm ?? 0, v.max_cargo_length_cm);
            if (v.max_cargo_width_cm != null) existing.maxWidthCm = Math.max(existing.maxWidthCm ?? 0, v.max_cargo_width_cm);
            if (v.max_cargo_height_cm != null) existing.maxHeightCm = Math.max(existing.maxHeightCm ?? 0, v.max_cargo_height_cm);
            const cats = new Set([...existing.acceptedCategories, ...((v.accepted_cargo_categories as PackageCategory[]) ?? [])]);
            existing.acceptedCategories = Array.from(cats);
          }
        }

        setDeliveryVehicleCaps(Array.from(byType.values()));
      } catch (err) {
        console.warn('[Delivery] Failed to fetch vehicle caps:', err);
      } finally {
        if (!cancelled) setDeliveryCapsLoading(false);
      }
    }

    fetchDeliveryCaps();
    return () => { cancelled = true; };
  }, [serviceType]);

  /* ─── Delivery vehicle compatibility check ─── */
  const deliveryPackageSpecs: PackageSpecs = {
    weightKg: deliveryWeight ? parseFloat(deliveryWeight) : undefined,
    lengthCm: deliveryLength ? parseInt(deliveryLength, 10) : undefined,
    widthCm: deliveryWidth ? parseInt(deliveryWidth, 10) : undefined,
    heightCm: deliveryHeight ? parseInt(deliveryHeight, 10) : undefined,
    category: deliveryCategory ?? undefined,
  };

  const deliveryVehicleOptions = (['moto', 'triciclo', 'auto'] as VehicleType[]).map((type) => {
    const caps = deliveryVehicleCaps.find((c) => c.type === type);
    if (!caps) {
      return { type, available: 0, compatible: false, reason: 'no_vehicles_available' };
    }
    const result = isPackageCompatible(deliveryPackageSpecs, {
      type: caps.type,
      maxWeightKg: caps.maxWeightKg,
      maxLengthCm: caps.maxLengthCm,
      maxWidthCm: caps.maxWidthCm,
      maxHeightCm: caps.maxHeightCm,
      acceptedCategories: caps.acceptedCategories,
      availableCount: caps.availableCount,
    });
    return { type, available: caps.availableCount, compatible: result.compatible, reason: result.reason };
  });

  /* ─── Fetch ALL nearby vehicles + ETAs when pickup changes ─── */
  useEffect(() => {
    if (!pickup) {
      setNearbyVehicles([]);
      return;
    }

    let cancelled = false;

    async function fetchVehicles() {
      setVehiclesLoading(true);
      try {
        // Fetch ALL vehicle types (no filter) to show ETAs per type on service cards
        const vehicles = await nearbyService.findNearbyVehicles({
          lat: pickup!.latitude,
          lng: pickup!.longitude,
          vehicleType: null,
          radiusM: 15000,
          limit: 50,
        });
        if (cancelled) return;

        // Calculate ETAs from each vehicle to the pickup point
        if (vehicles.length > 0) {
          const origins = vehicles.map((v) => ({ lat: v.latitude, lng: v.longitude }));
          const etas = await fetchETAsToPickup(origins, { lat: pickup!.latitude, lng: pickup!.longitude });
          if (!cancelled) {
            const enriched = vehicles.map((v, i) => ({
              ...v,
              eta_seconds: etas[i]?.duration_s ?? null,
              distance_to_pickup_m: etas[i]?.distance_m ?? null,
            }));
            setNearbyVehicles(enriched);
          }
        } else {
          setNearbyVehicles(vehicles);
        }
      } catch (err) {
        console.warn('Failed to fetch nearby vehicles:', err);
        if (!cancelled) setNearbyVehicles([]);
      } finally {
        if (!cancelled) setVehiclesLoading(false);
      }
    }

    fetchVehicles();
    return () => { cancelled = true; };
  }, [pickup]);

  /* ─── Subscribe to real-time driver positions ─── */
  useEffect(() => {
    const channel = nearbyService.subscribeToDriverPositions((update) => {
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
      if (realtimeChannelRef.current) {
        realtimeChannelRef.current.unsubscribe();
        realtimeChannelRef.current = null;
      }
    };
  }, []);

  /* ─── Geolocation ─── */
  const {
    latitude: userLat,
    longitude: userLng,
    loading: geoLoading,
    error: geoError,
    requestLocation,
  } = useGeolocation();
  const userLocation = userLat && userLng ? { latitude: userLat, longitude: userLng } : null;

  /* ─── Auto-set pickup from user location (like Uber) ─── */
  const autoSetPickupRef = useRef(false);

  useEffect(() => {
    if (autoSetPickupRef.current) return; // Only once
    if (!userLat || !userLng || pickup) return; // Need coords + no pickup yet

    autoSetPickupRef.current = true;

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

  /* ─── Route helper ─── */
  async function loadRoute(from: LocationPreset, to: LocationPreset) {
    const token = ++routeTokenRef.current;
    setRouteLoading(true);
    setRouteCoords(null);
    setRouteInfo(null);
    try {
      const result = await fetchRoute(
        { lat: from.latitude, lng: from.longitude },
        { lat: to.latitude, lng: to.longitude },
      );
      if (token !== routeTokenRef.current) return; // Stale — newer loadRoute in flight
      if (result) {
        setRouteCoords(result.coordinates);
        setRouteInfo({ distance_m: result.distance_m, duration_s: result.duration_s });
      }
    } catch {
      // Fallback: straight line will be shown
    } finally {
      if (token === routeTokenRef.current) setRouteLoading(false);
    }
  }

  /* ─── Map handlers ─── */
  function handleSetPickup(loc: LocationPreset) {
    setPickup(loc);
    pickupRef.current = loc;
    setAllEstimates({});
    setPromoResult(null);
    setSelectionStep(dropoff ? 'done' : 'dropoff');
    // Show address immediately from what the user selected
    if (loc.address && loc.address.includes('e/')) {
      setPickupAddress(loc.address);
    } else {
      setPickupAddress(loc.address || loc.label || null);
      const { latitude: lat, longitude: lng } = loc;
      reverseGeocode(lat, lng).then((addr) => {
        if (!addr) return;
        // Only apply if pickup hasn't changed since we started
        const cur = pickupRef.current;
        if (cur && cur.latitude === lat && cur.longitude === lng) {
          setPickupAddress(addr);
        }
      });
    }
    if (dropoff) {
      loadRoute(loc, dropoff);
    }
  }

  function handleSetDropoff(loc: LocationPreset) {
    setDropoff(loc);
    dropoffRef.current = loc;
    setAllEstimates({});
    setPromoResult(null);
    setSelectionStep(pickup ? 'done' : 'pickup');
    if (loc.address && loc.address.includes('e/')) {
      setDropoffAddress(loc.address);
    } else {
      setDropoffAddress(loc.address || loc.label || null);
      const { latitude: lat, longitude: lng } = loc;
      reverseGeocode(lat, lng).then((addr) => {
        if (!addr) return;
        const cur = dropoffRef.current;
        if (cur && cur.latitude === lat && cur.longitude === lng) {
          setDropoffAddress(addr);
        }
      });
    }
    if (pickup) {
      loadRoute(pickup, loc);
    }
  }

  function handleResetMap() {
    setPickup(null);
    setDropoff(null);
    setAllEstimates({});
    setPickupAddress(null);
    setDropoffAddress(null);
    setRouteCoords(null);
    setRouteInfo(null);
    setSelectionStep('pickup');
    setWaypoints([]);
    setIsScheduled(false);
    setScheduleDate('');
    setPromoCode('');
    setInsuranceSelected(false);
    setInsuranceExpanded(false);
    setCenterAddress(null);
    setCenterAddressLoading(false);
    setFlyToTarget(null);
    setPromoExpanded(false);
    setPromoResult(null);
    setPromoValidating(false);
  }

  function handleSwapLocations() {
    const newPickup = dropoff;
    const newDropoff = pickup;
    const newPickupAddr = dropoffAddress;
    const newDropoffAddr = pickupAddress;
    setPickup(newPickup);
    setDropoff(newDropoff);
    setPickupAddress(newPickupAddr);
    setDropoffAddress(newDropoffAddr);
    pickupRef.current = newPickup;
    dropoffRef.current = newDropoff;
    setAllEstimates({});
    setRouteCoords(null);
    setRouteInfo(null);
    // Reload route with swapped locations
    if (newPickup && newDropoff) {
      loadRoute(newPickup, newDropoff);
    }
  }

  async function handleUseMyLocation() {
    try {
      const coords = await requestLocation();
      // Fly the map to user location — user confirms with the center pin button
      setFlyToTarget({ latitude: coords.latitude, longitude: coords.longitude });
    } catch {
      // Error is handled by the hook state — displayed by BookingMap
    }
  }

  /* ─── Map center change → reverse geocode for address bar (F1) ─── */
  const handleMapCenterChange = useCallback((center: { latitude: number; longitude: number }) => {
    setMapCenter(center);
    if (selectionStep === 'done') return;
    // Debounce reverse geocode
    if (geocodeTimerRef.current) clearTimeout(geocodeTimerRef.current);
    if (geocodeAbortRef.current) geocodeAbortRef.current.abort();
    setCenterAddressLoading(true);
    geocodeTimerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      geocodeAbortRef.current = controller;
      try {
        const addr = await reverseGeocode(center.latitude, center.longitude);
        if (!controller.signal.aborted) {
          setCenterAddress(addr || `${center.latitude.toFixed(4)}, ${center.longitude.toFixed(4)}`);
          setCenterAddressLoading(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setCenterAddress(`${center.latitude.toFixed(4)}, ${center.longitude.toFixed(4)}`);
          setCenterAddressLoading(false);
        }
      }
    }, 300);
  }, [selectionStep]);

  /* ─── Confirm location from center pin (F1 + F2 road-snap) ─── */
  async function handleConfirmLocation(loc: LocationPreset) {
    if (selectionStep === 'pickup') {
      handleSetPickup(loc);
    } else if (selectionStep === 'dropoff') {
      // F2: Road-snap the dropoff to nearest drivable road
      setSnappingLoading(true);
      try {
        const snapped = await snapToNearestRoad(loc.latitude, loc.longitude);
        const snappedLoc: LocationPreset = {
          label: snapped.address || loc.label,
          address: snapped.address || loc.address,
          latitude: snapped.latitude,
          longitude: snapped.longitude,
        };
        if (snapped.distanceMoved > 20) {
          setSnappingToast(t('book.dropoff_snapped'));
          setTimeout(() => setSnappingToast(null), 3000);
        }
        handleSetDropoff(snappedLoc);
      } catch {
        // Fallback: use original location
        handleSetDropoff(loc);
      } finally {
        setSnappingLoading(false);
      }
    }
  }

  /* ─── Promo code validation (F3) ─── */
  async function handleApplyPromo() {
    if (!promoCode.trim() || promoValidating) return;
    setPromoValidating(true);
    setPromoResult(null);
    try {
      const { getSupabaseClient } = await import('@tricigo/api');
      const supabase = getSupabaseClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setPromoResult({ valid: false, error: t('book.error_auth') }); return; }
      const result = await rideService.validatePromoCode({
        code: promoCode.trim(),
        userId: user.id,
        fareAmount: selectedEstimate?.estimated_fare_cup || 0,
      });
      if (result.valid && result.promotion) {
        setPromoResult({
          valid: true,
          promoCodeId: result.promotion.id,
          discountPercent: result.promotion.discount_percent || undefined,
          discountFixed: result.promotion.discount_fixed_cup || undefined,
        });
      } else {
        const errKey = result.error === 'expired' ? 'promo_error_expired'
          : result.error === 'max_uses' ? 'promo_error_max_uses'
          : result.error === 'already_used' ? 'promo_error_already_used'
          : 'promo_error_invalid';
        setPromoResult({ valid: false, error: t(`book.${errKey}`) });
      }
    } catch {
      setPromoResult({ valid: false, error: t('book.promo_error_invalid') });
    } finally {
      setPromoValidating(false);
    }
  }

  function getDiscountedFare(fareCup: number): number {
    if (!promoResult?.valid) return fareCup;
    if (promoResult.discountPercent) {
      return Math.round(fareCup * (1 - promoResult.discountPercent / 100));
    }
    if (promoResult.discountFixed) {
      return Math.max(0, fareCup - promoResult.discountFixed);
    }
    return fareCup;
  }

  /* ─── Ride estimate/request ─── */
  const canEstimate =
    pickup &&
    dropoff &&
    (pickup.latitude !== dropoff.latitude || pickup.longitude !== dropoff.longitude);

  const handleEstimateAll = useCallback(async () => {
    if (!pickup || !dropoff || estimateLoading) return;
    setEstimateLoading(true);
    setAllEstimates({});

    const serviceTypes: ServiceTypeSlug[] = ['triciclo_basico', 'moto_standard', 'auto_standard'];

    try {
      const results = await Promise.allSettled(
        serviceTypes.map(st =>
          rideService.getLocalFareEstimate({
            pickup_lat: pickup.latitude,
            pickup_lng: pickup.longitude,
            dropoff_lat: dropoff.latitude,
            dropoff_lng: dropoff.longitude,
            service_type: st,
          })
        )
      );

      const estimates: Record<string, FareEstimate | null> = {};
      serviceTypes.forEach((st, i) => {
        const r = results[i];
        estimates[st] = r.status === 'fulfilled' ? r.value : null;
      });
      setAllEstimates(estimates);
    } catch {
      // Silently fail — user can retry
    } finally {
      setEstimateLoading(false);
    }
  }, [pickup, dropoff, estimateLoading]);

  /* ─── Auto-fetch estimates when both locations set ─── */
  useEffect(() => {
    if (pickup && dropoff && Object.keys(allEstimates).length === 0 && !estimateLoading) {
      handleEstimateAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickup?.latitude, pickup?.longitude, dropoff?.latitude, dropoff?.longitude, handleEstimateAll]);

  async function handleRequest() {
    if (!pickup || !dropoff) return;
    if (isRequestingRef.current) return;

    // Delivery validation
    const isDelivery = serviceType === 'mensajeria';
    if (isDelivery) {
      if (!deliveryCategory) { setError('Selecciona el tipo de paquete.'); return; }
      if (!recipientName.trim()) { setError('Ingresa el nombre del destinatario.'); return; }
      if (!recipientPhone.trim()) { setError('Ingresa el teléfono del destinatario.'); return; }
      if (!deliveryVehicleType) { setError('Selecciona un vehículo para tu envío.'); return; }
    }

    // For delivery, get the fare estimate from the selected vehicle's slug
    const effectiveServiceType = isDelivery && deliveryVehicleType
      ? deliveryVehicleToSlug(deliveryVehicleType)
      : serviceType;
    const effectiveEstimate = isDelivery && deliveryVehicleType
      ? allEstimates[deliveryVehicleToSlug(deliveryVehicleType)] || selectedEstimate
      : selectedEstimate;

    if (!effectiveEstimate) { setError('No se pudo calcular la tarifa.'); return; }

    // Validate scheduled date
    if (isScheduled) {
      if (!scheduleDate) {
        setError('Selecciona una fecha y hora para el viaje programado.');
        return;
      }
      if (new Date(scheduleDate).getTime() < Date.now()) {
        setError('La fecha programada debe ser en el futuro.');
        return;
      }
    }
    isRequestingRef.current = true;
    setIsRequesting(true);
    setError(null);
    try {
      const ride = await rideService.createRide({
        service_type: effectiveServiceType,
        payment_method: paymentMethod,
        ride_mode: isDelivery ? 'cargo' : 'passenger',
        pickup_latitude: pickup.latitude,
        pickup_longitude: pickup.longitude,
        pickup_address: [pickup.label, pickup.address].filter(Boolean).join(' — '),
        dropoff_latitude: dropoff.latitude,
        dropoff_longitude: dropoff.longitude,
        dropoff_address: [dropoff.label, dropoff.address].filter(Boolean).join(' — '),
        estimated_fare_cup: effectiveEstimate.estimated_fare_cup,
        estimated_distance_m: effectiveEstimate.estimated_distance_m,
        estimated_duration_s: effectiveEstimate.estimated_duration_s,
        // W1.1: Waypoints
        ...(waypoints.length > 0 && {
          waypoints: waypoints.map((wp, i) => ({
            sort_order: i + 1,
            latitude: wp.latitude,
            longitude: wp.longitude,
            address: wp.address || wp.label,
          })),
        }),
        // W1.2: Scheduled ride
        ...(isScheduled && scheduleDate && {
          scheduled_at: new Date(scheduleDate).toISOString(),
        }),
        // W1.3: Promo code
        ...(promoResult?.valid && promoResult.promoCodeId && {
          promo_code_id: promoResult.promoCodeId,
        }),
        // W1.4: Insurance
        insurance_selected: insuranceSelected,
        ...(insuranceSelected && effectiveEstimate.insurance_premium_cup && {
          insurance_premium_cup: effectiveEstimate.insurance_premium_cup,
        }),
      });
      // Create delivery details if this is a delivery ride
      if (isDelivery) {
        try {
          await deliveryService.createDeliveryDetails({
            ride_id: ride.id,
            package_description: deliveryCategory || 'Delivery',
            recipient_name: recipientName,
            recipient_phone: recipientPhone,
            estimated_weight_kg: deliveryWeight ? parseFloat(deliveryWeight) : undefined,
            special_instructions: specialInstructions || undefined,
            package_category: deliveryCategory ?? undefined,
            package_length_cm: deliveryLength ? parseInt(deliveryLength, 10) : undefined,
            package_width_cm: deliveryWidth ? parseInt(deliveryWidth, 10) : undefined,
            package_height_cm: deliveryHeight ? parseInt(deliveryHeight, 10) : undefined,
            client_accompanies: clientAccompanies,
            delivery_vehicle_type: deliveryVehicleType ?? undefined,
          });
        } catch (err) {
          console.warn('[Book] Delivery details failed:', err);
        }
      }

      // Full page navigation to ensure fresh JS chunks are loaded
      window.location.href = `/track/${ride.id}`;
    } catch (err: unknown) {
      console.error('[Book] createRide failed:', err);
      const msg = err instanceof Error
        ? err.message
        : (err && typeof err === 'object' && 'message' in err)
          ? String((err as { message: unknown }).message)
          : JSON.stringify(err);
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
      isRequestingRef.current = false;
      setIsRequesting(false);
    }
  }

  /* ─── Auth gate (after all hooks) ─── */
  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0d0d1a' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </div>
          <p style={{ fontSize: '0.875rem' }}>{t('web.loading', { defaultValue: 'Cargando...' })}</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    router.replace('/login');
    return null;
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

        {/* ═══ Address Autocomplete (WF-2) ═══ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1rem' }}>
          <AddressAutocomplete
            label={t('web.address_origin', { defaultValue: 'Origen' })}
            placeholder="¿Dónde te recogemos?"
            value={pickupAddress || ''}
            mapboxToken={mapboxToken}
            savedLocations={savedLocations}
            proximity={mapCenter}
            enrichAddress={reverseGeocode}
            onSelect={(r) => {
              const loc = { label: r.place_name, address: r.address, latitude: r.latitude, longitude: r.longitude };
              handleSetPickup(loc);
            }}
            onClear={() => {
              setPickup(null);
              pickupRef.current = null;
              setPickupAddress(null);
              setSelectionStep('pickup');
              setAllEstimates({});
              setRouteCoords(null);
              setRouteInfo(null);
            }}
          />

          {/* Swap button */}
          {pickup && dropoff && (
            <div style={{ display: 'flex', justifyContent: 'center', margin: '-0.25rem 0' }}>
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
          )}

          <AddressAutocomplete
            label={t('web.address_destination', { defaultValue: 'Destino' })}
            placeholder="¿A dónde vas?"
            value={dropoffAddress || ''}
            mapboxToken={mapboxToken}
            savedLocations={savedLocations}
            proximity={mapCenter}
            enrichAddress={reverseGeocode}
            onSelect={(r) => {
              const loc = { label: r.place_name, address: r.address, latitude: r.latitude, longitude: r.longitude };
              handleSetDropoff(loc);
            }}
            onClear={() => {
              setDropoff(null);
              dropoffRef.current = null;
              setDropoffAddress(null);
              setSelectionStep('dropoff');
              setAllEstimates({});
              setRouteCoords(null);
              setRouteInfo(null);
            }}
          />
        </div>

        {/* ═══ MAP ═══ */}
        <BookingMap
          pickup={pickup}
          dropoff={dropoff}
          userLocation={userLocation}
          onSetPickup={handleSetPickup}
          onSetDropoff={handleSetDropoff}
          onRequestLocation={handleUseMyLocation}
          onConfirmLocation={handleConfirmLocation}
          locationLoading={geoLoading}
          locationError={geoError}
          selectionStep={selectionStep}
          pickupAddress={pickupAddress}
          dropoffAddress={dropoffAddress}
          centerAddress={centerAddress}
          centerAddressLoading={centerAddressLoading}
          flyToTarget={flyToTarget}
          routeCoords={routeCoords}
          routeLoading={routeLoading || snappingLoading}
          nearbyVehicles={nearbyVehicles}
          selectedServiceType={serviceType}
          initialCenter={userLocation ?? undefined}
          onMapCenterChange={handleMapCenterChange}
        />

        {/* ═══ Road-snap toast (F2) ═══ */}
        {snappingToast && (
          <div style={{
            position: 'fixed', top: '1rem', left: '50%', transform: 'translateX(-50%)',
            background: '#1a1a2e', border: '1px solid var(--primary)', padding: '0.5rem 1rem',
            borderRadius: '0.5rem', zIndex: 1000, fontSize: '0.8rem', color: '#e5e5e5',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}>
            {snappingToast}
          </div>
        )}

        {/* ═══ Reset button ═══ */}
        {pickup && dropoff && (
          <button
            type="button"
            onClick={handleResetMap}
            aria-label="Reiniciar seleccion de mapa"
            style={{
              width: '100%',
              marginTop: '0.5rem',
              padding: '0.5rem',
              borderRadius: '0.5rem',
              border: '1px solid var(--border)',
              background: 'var(--bg-card)',
              cursor: 'pointer',
              fontSize: '0.8rem',
              color: 'var(--text-secondary)',
            }}
          >
            {t('book.map_reset')}
          </button>
        )}

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
                  background: '#f0fdf4',
                  border: '1px solid #86efac',
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
                  background: '#fef2f2',
                  border: '1px solid #fca5a5',
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
            {pickup && dropoff && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {waypoints.map((wp, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '0.5rem 0.75rem',
                      borderRadius: '0.5rem',
                      background: '#fffbeb',
                      border: '1px solid #fcd34d',
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
                      onClick={() => setWaypoints((prev) => prev.filter((_, i) => i !== idx))}
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
                        enrichAddress={reverseGeocode}
                        savedLocations={savedLocations}
                        onSelect={(r) => {
                          setWaypoints((prev) => [
                            ...prev,
                            { label: r.place_name, address: r.address, latitude: r.latitude, longitude: r.longitude },
                          ]);
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
            )}

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
          {pickup && dropoff && (
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                {t('book.choose_service', { defaultValue: 'Elige tu servicio' })}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {SERVICE_TYPE_KEYS.map((svc) => {
                  const est = allEstimates[svc.slug];
                  const isSelected = serviceType === svc.slug;
                  const isLoading = estimateLoading && !est;

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
                          src={svc.image}
                          alt={t(svc.labelKey)}
                          width={48}
                          height={48}
                          style={{ objectFit: 'contain', flexShrink: 0 }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                            {t(svc.labelKey)}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: 2 }}>
                            {t(svc.descKey)}
                            {(() => {
                              const vType = serviceTypeToVehicleType(svc.slug);
                              const vehiclesOfType = nearbyVehicles.filter(
                                (v) => (vType ? v.vehicle_type === vType : true) && v.eta_seconds != null,
                              );
                              if (vehiclesOfType.length === 0) return null;
                              const minEta = Math.min(...vehiclesOfType.map((v) => v.eta_seconds!));
                              const mins = Math.ceil(minEta / 60);
                              return (
                                <span style={{ marginLeft: 6, color: '#22c55e', fontWeight: 600 }}>
                                  · {mins} min
                                </span>
                              );
                            })()}
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {isLoading ? (
                          <div style={{ width: 60, height: 14, borderRadius: 4, background: 'var(--border-light)', animation: 'pulse 1.5s ease-in-out infinite' }} />
                        ) : est ? (
                          <>
                            {promoResult?.valid ? (
                              <>
                                <div style={{ textDecoration: 'line-through', color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
                                  {formatCUP(est.estimated_fare_cup)}
                                </div>
                                <div style={{ fontWeight: 700, fontSize: '1rem', color: isSelected ? 'var(--primary)' : 'var(--text-primary)' }}>
                                  {formatCUP(getDiscountedFare(est.estimated_fare_cup))}
                                </div>
                              </>
                            ) : (
                              <div style={{ fontWeight: 700, fontSize: '1rem', color: isSelected ? 'var(--primary)' : 'var(--text-primary)' }}>
                                {formatCUP(est.estimated_fare_cup)}
                              </div>
                            )}
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
                              ~{Math.ceil((est.estimated_duration_s || 0) / 60)} min
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                            {svc.slug === 'mensajeria' ? t('book.select_to_configure', { defaultValue: 'Seleccionar' }) : '\u2014'}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}


          {/* ═══ Delivery form — when mensajería selected ═══ */}
          {serviceType === 'mensajeria' && pickup && dropoff && (
            <div style={{
              background: 'var(--card-bg)',
              borderRadius: '0.75rem',
              border: '1px solid var(--border)',
              padding: '1rem',
              marginBottom: '1rem',
            }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--text-primary)' }}>
                {t('book.delivery_title', { defaultValue: 'Detalles del envío' })}
              </h3>

              {/* Package category chips */}
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.375rem', fontWeight: 500 }}>
                {t('book.delivery_category', { defaultValue: 'Tipo de paquete' })} *
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
                {PACKAGE_CATEGORIES.map((cat) => {
                  const selected = deliveryCategory === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setDeliveryCategory(selected ? null : cat)}
                      style={{
                        padding: '0.375rem 0.75rem',
                        borderRadius: '999px',
                        border: `1.5px solid ${selected ? 'var(--primary)' : 'var(--border)'}`,
                        background: selected ? 'var(--primary-light, rgba(249,115,22,0.1))' : 'transparent',
                        color: selected ? 'var(--primary)' : 'var(--text-secondary)',
                        fontSize: '0.8rem',
                        fontWeight: selected ? 600 : 400,
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                      }}
                    >
                      {PACKAGE_CATEGORY_LABELS[cat]?.es ?? cat}
                    </button>
                  );
                })}
              </div>

              {/* Weight + dimensions row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                    {t('book.delivery_weight', { defaultValue: 'Peso (kg)' })}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={deliveryWeight}
                    onChange={(e) => setDeliveryWeight(e.target.value)}
                    placeholder="5"
                    style={{
                      width: '100%', padding: '0.5rem', borderRadius: '0.5rem',
                      border: '1px solid var(--border)', background: 'var(--input-bg, transparent)',
                      color: 'var(--text-primary)', fontSize: '0.85rem',
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                    {t('book.delivery_length', { defaultValue: 'Largo (cm)' })}
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={deliveryLength}
                    onChange={(e) => setDeliveryLength(e.target.value)}
                    placeholder="50"
                    style={{
                      width: '100%', padding: '0.5rem', borderRadius: '0.5rem',
                      border: '1px solid var(--border)', background: 'var(--input-bg, transparent)',
                      color: 'var(--text-primary)', fontSize: '0.85rem',
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                    {t('book.delivery_width', { defaultValue: 'Ancho (cm)' })}
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={deliveryWidth}
                    onChange={(e) => setDeliveryWidth(e.target.value)}
                    placeholder="30"
                    style={{
                      width: '100%', padding: '0.5rem', borderRadius: '0.5rem',
                      border: '1px solid var(--border)', background: 'var(--input-bg, transparent)',
                      color: 'var(--text-primary)', fontSize: '0.85rem',
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                    {t('book.delivery_height', { defaultValue: 'Alto (cm)' })}
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={deliveryHeight}
                    onChange={(e) => setDeliveryHeight(e.target.value)}
                    placeholder="20"
                    style={{
                      width: '100%', padding: '0.5rem', borderRadius: '0.5rem',
                      border: '1px solid var(--border)', background: 'var(--input-bg, transparent)',
                      color: 'var(--text-primary)', fontSize: '0.85rem',
                    }}
                  />
                </div>
              </div>

              {/* Recipient info */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                    {t('book.delivery_recipient_name', { defaultValue: 'Nombre destinatario' })} *
                  </label>
                  <input
                    type="text"
                    value={recipientName}
                    onChange={(e) => setRecipientName(e.target.value)}
                    placeholder="Juan Pérez"
                    style={{
                      width: '100%', padding: '0.5rem', borderRadius: '0.5rem',
                      border: '1px solid var(--border)', background: 'var(--input-bg, transparent)',
                      color: 'var(--text-primary)', fontSize: '0.85rem',
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                    {t('book.delivery_recipient_phone', { defaultValue: 'Teléfono destinatario' })} *
                  </label>
                  <input
                    type="tel"
                    value={recipientPhone}
                    onChange={(e) => setRecipientPhone(e.target.value)}
                    placeholder="+53 5555 1234"
                    style={{
                      width: '100%', padding: '0.5rem', borderRadius: '0.5rem',
                      border: '1px solid var(--border)', background: 'var(--input-bg, transparent)',
                      color: 'var(--text-primary)', fontSize: '0.85rem',
                    }}
                  />
                </div>
              </div>

              {/* Client accompanies toggle */}
              <label style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                marginBottom: '0.75rem', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-secondary)',
              }}>
                <input
                  type="checkbox"
                  checked={clientAccompanies}
                  onChange={(e) => setClientAccompanies(e.target.checked)}
                  style={{ width: 18, height: 18, accentColor: 'var(--primary)' }}
                />
                {t('book.delivery_accompanies', { defaultValue: '¿Acompaña el envío?' })}
              </label>

              {/* Special instructions */}
              <div style={{ marginBottom: '0.75rem' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                  {t('book.delivery_instructions', { defaultValue: 'Instrucciones especiales (opcional)' })}
                </label>
                <textarea
                  value={specialInstructions}
                  onChange={(e) => setSpecialInstructions(e.target.value)}
                  placeholder="Ej: Tocar timbre 2 veces, dejar en portería..."
                  rows={2}
                  style={{
                    width: '100%', padding: '0.5rem', borderRadius: '0.5rem',
                    border: '1px solid var(--border)', background: 'var(--input-bg, transparent)',
                    color: 'var(--text-primary)', fontSize: '0.85rem', resize: 'vertical',
                  }}
                />
              </div>

              {/* Vehicle selector for delivery */}
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.375rem', fontWeight: 500 }}>
                {t('book.delivery_choose_vehicle', { defaultValue: 'Elige vehículo para tu envío' })} *
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
                {deliveryVehicleOptions.map((opt) => {
                  const selected = deliveryVehicleType === opt.type;
                  const disabled = !opt.compatible;
                  const vehicleSlug = deliveryVehicleToSlug(opt.type);
                  const est = allEstimates[vehicleSlug];
                  const reasonLabel = opt.reason && INCOMPATIBILITY_REASON_LABELS[opt.reason]?.es;

                  return (
                    <button
                      key={opt.type}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        if (!disabled) setDeliveryVehicleType(opt.type);
                      }}
                      style={{
                        padding: '0.75rem 0.5rem',
                        borderRadius: '0.75rem',
                        border: `2px solid ${selected ? 'var(--primary)' : disabled ? 'var(--border-light, #444)' : 'var(--border)'}`,
                        background: selected ? 'var(--primary-light, rgba(249,115,22,0.1))' : disabled ? 'var(--disabled-bg, rgba(100,100,100,0.1))' : 'transparent',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        opacity: disabled ? 0.5 : 1,
                        textAlign: 'center',
                        transition: 'all 0.15s',
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/images/vehicles/${opt.type === 'triciclo' ? 'triciclo' : opt.type === 'moto' ? 'moto' : 'auto'}.png`}
                        alt={opt.type}
                        style={{ width: 40, height: 40, objectFit: 'contain', margin: '0 auto 0.25rem' }}
                      />
                      <div style={{ fontWeight: 600, fontSize: '0.85rem', color: disabled ? 'var(--text-tertiary)' : 'var(--text-primary)', textTransform: 'capitalize' }}>
                        {opt.type}
                      </div>
                      {est ? (
                        <div style={{ fontSize: '0.8rem', fontWeight: 700, color: selected ? 'var(--primary)' : 'var(--text-primary)', marginTop: 2 }}>
                          {formatCUP(est.estimated_fare_cup)}
                        </div>
                      ) : (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: 2 }}>
                          {estimateLoading ? '...' : '\u2014'}
                        </div>
                      )}
                      {disabled && reasonLabel && (
                        <div style={{ fontSize: '0.65rem', color: 'var(--error, #ef4444)', marginTop: 2 }}>
                          {reasonLabel}
                        </div>
                      )}
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginTop: 2 }}>
                        {opt.available > 0 ? `${opt.available} disponible${opt.available > 1 ? 's' : ''}` : 'Sin vehículos'}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ═══ Promo code (F3) — below service cards ═══ */}
          {pickup && dropoff && selectedEstimate && (
            <div style={{ marginBottom: '0.5rem' }}>
              <button
                type="button"
                onClick={() => setPromoExpanded(!promoExpanded)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '0.25rem 0',
                }}
              >
                <span style={{ transform: promoExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', fontSize: '0.7rem' }}>{'\u25B6'}</span>
                {t('book.promo_question')}
              </button>
              {promoExpanded && (
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <input
                    type="text"
                    value={promoCode}
                    onChange={(e) => { setPromoCode(e.target.value.toUpperCase()); setPromoResult(null); }}
                    placeholder={t('book.promo_placeholder')}
                    aria-label="Codigo promocional"
                    style={{
                      flex: 1, padding: '0.5rem', borderRadius: '0.5rem',
                      border: '1px solid var(--border)', background: 'var(--bg-card)',
                      fontSize: '0.85rem', boxSizing: 'border-box',
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleApplyPromo}
                    disabled={promoValidating || !promoCode.trim()}
                    style={{
                      padding: '0.5rem 1rem', borderRadius: '0.5rem', border: 'none',
                      background: promoValidating ? '#ccc' : 'var(--primary)', color: 'white',
                      fontSize: '0.85rem', fontWeight: 600,
                      cursor: promoValidating ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {promoValidating ? t('book.promo_applying') : t('book.promo_apply')}
                  </button>
                </div>
              )}
              {promoResult?.valid && (
                <div style={{
                  marginTop: '0.5rem', padding: '0.4rem 0.75rem', borderRadius: '0.5rem',
                  background: 'rgba(34,197,94,0.1)', border: '1px solid #22c55e',
                  fontSize: '0.8rem', color: '#22c55e', fontWeight: 600,
                }}>
                  {'\u2713'} {promoResult.discountPercent
                    ? t('book.promo_success', { percent: promoResult.discountPercent })
                    : t('book.promo_success_fixed', { amount: promoResult.discountFixed || 0 })}
                </div>
              )}
              {promoResult && !promoResult.valid && (
                <div style={{
                  marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--error, #ef4444)',
                }}>
                  {promoResult.error}
                </div>
              )}
            </div>
          )}

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
          {selectedEstimate && (
            <div
              className="booking-estimate-card"
              style={{
                padding: '1.25rem',
                borderRadius: '0.75rem',
                border: '2px solid var(--primary)',
                background: 'var(--bg-accent, rgba(255,77,0,0.05))',
              }}
            >
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
                  {promoResult?.valid && (
                    <span style={{ textDecoration: 'line-through', color: 'var(--text-tertiary)', fontSize: '0.9rem', marginRight: '0.5rem' }}>
                      {formatCUP(selectedEstimate.estimated_fare_cup)}
                    </span>
                  )}
                  <span style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--primary)' }}>
                    {formatCUP(promoResult?.valid ? getDiscountedFare(selectedEstimate.estimated_fare_cup) : selectedEstimate.estimated_fare_cup)}
                  </span>
                </div>
              </div>
              <div
                className="booking-fare-details"
                style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem', color: 'var(--text-secondary)', flexWrap: 'wrap' }}
              >
                <span>{(selectedEstimate.estimated_distance_m / 1000).toFixed(1)} km</span>
                <span>{Math.round(selectedEstimate.estimated_duration_s / 60)} min</span>
                <span style={{ color: 'var(--text-tertiary)' }}>
                  ~${(selectedEstimate.estimated_fare_cup / (selectedEstimate.exchange_rate_usd_cup || 300)).toFixed(2)} USD
                </span>
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {'\u2248'} {formatCUP(selectedEstimate.estimated_fare_cup)}
                </span>
                {selectedEstimate.surge_multiplier > 1 && (
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
                    {selectedEstimate.surge_multiplier.toFixed(1)}x {t('book.surge_active')}
                  </span>
                )}
              </div>
              {selectedEstimate.per_km_rate_cup > 0 && (
                <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                  {t('book.per_km_rate', {
                    rate: formatCUP(selectedEstimate.per_km_rate_cup),
                  })}
                </p>
              )}
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: '#bbb' }}>
                1 USD = {selectedEstimate.exchange_rate_usd_cup} CUP
              </p>

              {/* Payment method */}
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
                      background: paymentMethod === 'cash' ? '#FFF5F0' : 'white',
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
                      background: paymentMethod === 'tricicoin' ? '#FFF5F0' : 'white',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      fontWeight: paymentMethod === 'tricicoin' ? 700 : 400,
                    }}
                  >
                    {t('book.payment_tricicoin')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ═══ Insurance card (F4) ═══ */}
          {selectedEstimate && (selectedEstimate.insurance_available !== false) && (selectedEstimate.insurance_premium_cup ?? 0) > 0 && (
            <div
              style={{
                padding: '1rem',
                borderRadius: '0.75rem',
                border: insuranceSelected ? '2px solid #22c55e' : '1px solid var(--border)',
                background: insuranceSelected ? 'rgba(34,197,94,0.06)' : 'var(--card-bg)',
                transition: 'all 0.2s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span style={{ fontSize: '1.3rem' }}>{'\uD83D\uDEE1\uFE0F'}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                      {t('book.insurance_title')}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                      +{formatCUP(selectedEstimate.insurance_premium_cup || 0)}
                    </div>
                  </div>
                </div>
                {/* Toggle switch */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={insuranceSelected}
                  aria-label="Activar seguro de viaje"
                  onClick={() => setInsuranceSelected(!insuranceSelected)}
                  style={{
                    width: 44, height: 24, borderRadius: 12, border: 'none', padding: 0,
                    background: insuranceSelected ? '#22c55e' : '#555',
                    cursor: 'pointer', position: 'relative', transition: 'background 0.2s',
                    flexShrink: 0,
                  }}
                >
                  <div style={{
                    width: 20, height: 20, borderRadius: '50%', background: 'white',
                    position: 'absolute', top: 2,
                    left: insuranceSelected ? 22 : 2,
                    transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                  }} />
                </button>
              </div>
              <button
                type="button"
                onClick={() => setInsuranceExpanded(!insuranceExpanded)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text-secondary)', fontSize: '0.75rem', padding: '0.25rem 0', marginTop: '0.5rem',
                  textDecoration: 'underline',
                }}
              >
                {insuranceExpanded ? t('book.insurance_hide_coverage') : t('book.insurance_show_coverage')}
              </button>
              {insuranceExpanded && (
                <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    <li style={{ marginBottom: '0.25rem' }}>{'\u2713'} {t('book.insurance_accidents')}</li>
                    <li style={{ marginBottom: '0.25rem' }}>{'\u2713'} {t('book.insurance_luggage')}</li>
                    <li>{'\u2713'} {t('book.insurance_medical')}</li>
                  </ul>
                  <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: '0.5rem', marginBottom: 0 }}>
                    {t('book.insurance_provider')}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ═══ More options (collapsible) ═══ */}
          {selectedEstimate && (
            <div style={{ marginBottom: '1rem' }}>
              <button
                type="button"
                onClick={() => setShowOptions(!showOptions)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '0.5rem 0',
                }}
              >
                <span style={{ transform: showOptions ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>{'\u25B6'}</span>
                {t('book.more_options', { defaultValue: 'M\u00e1s opciones' })}
              </button>
              {showOptions && (
                <div style={{ paddingLeft: '1rem', marginTop: '0.5rem' }}>
                  {/* ═══ Scheduled ride (W1.2) ═══ */}
                  <div style={{ marginTop: '0.75rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={isScheduled}
                        aria-label="Programar viaje para despues"
                        onChange={(e) => {
                          setIsScheduled(e.target.checked);
                          if (!e.target.checked) setScheduleDate('');
                        }}
                      />
                      <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Programar viaje</span>
                    </label>
                    {isScheduled && (
                      <input
                        type="datetime-local"
                        value={scheduleDate}
                        onChange={(e) => setScheduleDate(e.target.value)}
                        min={new Date().toISOString().slice(0, 16)}
                        aria-label="Fecha y hora del viaje programado"
                        style={{
                          width: '100%', marginTop: '0.5rem', padding: '0.5rem',
                          borderRadius: '0.5rem', border: '1px solid var(--border)',
                          fontSize: '0.85rem', boxSizing: 'border-box',
                        }}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Request button with price */}
          {selectedEstimate && (
            <button
              onClick={handleRequest}
              disabled={isRequesting || !selectedEstimate}
              aria-label="Solicitar viaje ahora"
              style={{
                width: '100%',
                padding: '1rem',
                borderRadius: '0.75rem',
                border: 'none',
                background: isRequesting ? '#ccc' : 'var(--primary)',
                color: 'white',
                fontSize: '1rem',
                fontWeight: 700,
                cursor: isRequesting ? 'not-allowed' : 'pointer',
                marginTop: '0.5rem',
              }}
            >
              {isRequesting
                ? t('book.requesting')
                : `${t('book.request_ride', { defaultValue: 'Solicitar' })} ${t(SERVICE_TYPE_KEYS.find(s => s.slug === serviceType)?.labelKey || '')} \u00b7 ${formatCUP(promoResult?.valid ? getDiscountedFare(selectedEstimate.estimated_fare_cup) : selectedEstimate.estimated_fare_cup)}`
              }
            </button>
          )}
        </div>


        {/* Spacer for fixed bottom CTA on mobile */}
        {selectedEstimate && <div style={{ height: '5rem' }} className="booking-cta-spacer" />}
      </div>

      {/* Fixed bottom CTA on mobile */}
      {selectedEstimate && (
        <div className="booking-cta-fixed">
          {error && (
            <p style={{
              color: '#FF4D00', fontSize: '0.8rem', textAlign: 'center',
              margin: '0 0 0.5rem', padding: '0.5rem', background: 'rgba(255,77,0,0.1)',
              borderRadius: '0.5rem',
            }}>
              {error}
            </p>
          )}
          <button
            onClick={handleRequest}
            disabled={isRequesting || !selectedEstimate}
            style={{
              width: '100%',
              padding: '1rem',
              borderRadius: '0.75rem',
              border: 'none',
              background: isRequesting ? '#ccc' : 'var(--primary)',
              color: 'white',
              fontSize: '1rem',
              fontWeight: 700,
              cursor: isRequesting ? 'not-allowed' : 'pointer',
            }}
          >
            {isRequesting
              ? t('book.requesting')
              : `${t('book.request_ride', { defaultValue: 'Solicitar' })} ${t(SERVICE_TYPE_KEYS.find(s => s.slug === serviceType)?.labelKey || '')} \u00b7 ${formatCUP(promoResult?.valid ? getDiscountedFare(selectedEstimate.estimated_fare_cup) : selectedEstimate.estimated_fare_cup)}`
            }
          </button>
        </div>
      )}
    </main>
  );
}
