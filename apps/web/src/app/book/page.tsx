'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';
import { formatTRC, formatTRCasUSD, formatCUP, findNearestPreset, serviceTypeToVehicleType, fetchETAsToPickup } from '@tricigo/utils';
import type { LocationPreset } from '@tricigo/utils';
import { rideService, nearbyService, customerService } from '@tricigo/api';
import type { FareEstimate, ServiceTypeSlug, PaymentMethod, NearbyVehicle, VehicleType } from '@tricigo/types';
import { useGeolocation } from '../../hooks/useGeolocation';
import { fetchRoute, reverseGeocode } from '../../services/geoService';
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

const SERVICE_TYPE_KEYS: { slug: ServiceTypeSlug; abbr: string; label: string; desc: string; icon: string }[] = [
  { slug: 'triciclo_basico', abbr: 'TC', label: 'Triciclo', desc: 'Econ\u00f3mico', icon: '/images/vehicles/triciclo.png' },
  { slug: 'moto_standard', abbr: 'MT', label: 'Moto', desc: 'R\u00e1pido', icon: '/images/vehicles/moto.png' },
  { slug: 'auto_standard', abbr: 'AT', label: 'Auto', desc: 'C\u00f3modo', icon: '/images/vehicles/auto.png' },
  { slug: 'auto_confort', abbr: 'CF', label: 'Confort', desc: 'Premium', icon: '/images/vehicles/confort.png' },
  { slug: 'mensajeria', abbr: 'DL', label: 'Env\u00edo', desc: 'Delivery', icon: '/images/vehicles/mensajeria.png' },
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
  const [mapCenter, setMapCenter] = useState({ latitude: 23.1136, longitude: -82.3666 });

  /* ─── Ride state ─── */
  const [serviceType, setServiceType] = useState<ServiceTypeSlug>('triciclo_basico');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [estimate, setEstimate] = useState<FareEstimate | null>(null);
  const [allEstimates, setAllEstimates] = useState<Record<string, FareEstimate | null>>({});
  const [estimateLoading, setEstimateLoading] = useState(false);
  const selectedEstimate = allEstimates[serviceType] || null;
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
  const [flyToTarget, setFlyToTarget] = useState<{ latitude: number; longitude: number } | null>(null);

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

  /* ─── Nearby vehicles state ─── */
  const [nearbyVehicles, setNearbyVehicles] = useState<NearbyVehicle[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);
  const realtimeChannelRef = useRef<ReturnType<typeof nearbyService.subscribeToDriverPositions> | null>(null);

  /* ─── ETA by vehicle type (closest driver per type) ─── */
  const [etaByType, setEtaByType] = useState<Record<VehicleType, number | null>>({
    triciclo: null,
    moto: null,
    auto: null,
  });

  /* ─── Fetch nearby vehicles when pickup changes ─── */
  useEffect(() => {
    if (!pickup) {
      setNearbyVehicles([]);
      setEtaByType({ triciclo: null, moto: null, auto: null });
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
          radiusM: 15000,
          limit: 50,
        });
        if (cancelled) return;
        setNearbyVehicles(vehicles);

        // Calculate ETA per vehicle type (closest driver of each type)
        const typeGroups: Record<VehicleType, NearbyVehicle | null> = { triciclo: null, moto: null, auto: null };
        for (const v of vehicles) {
          const vt = v.vehicle_type as VehicleType;
          if (vt && !typeGroups[vt]) {
            typeGroups[vt] = v; // first = closest (RPC returns sorted by distance)
          }
        }

        const closestPerType = (['triciclo', 'moto', 'auto'] as VehicleType[])
          .map((vt) => typeGroups[vt])
          .filter(Boolean) as NearbyVehicle[];

        if (closestPerType.length > 0) {
          const origins = closestPerType.map((v) => ({ lat: v.latitude, lng: v.longitude }));
          const dest = { lat: pickup!.latitude, lng: pickup!.longitude };
          const etas = await fetchETAsToPickup(origins, dest);

          if (!cancelled) {
            const newEtas: Record<VehicleType, number | null> = { triciclo: null, moto: null, auto: null };
            let idx = 0;
            for (const vt of ['triciclo', 'moto', 'auto'] as VehicleType[]) {
              if (typeGroups[vt]) {
                const etaResult = etas[idx];
                newEtas[vt] = etaResult ? Math.ceil(etaResult.duration_s / 60) : null;
                idx++;
              }
            }
            setEtaByType(newEtas);
          }
        } else if (!cancelled) {
          setEtaByType({ triciclo: null, moto: null, auto: null });
        }
      } catch (err) {
        console.warn('Failed to fetch nearby vehicles:', err);
        if (!cancelled) {
          setNearbyVehicles([]);
          setEtaByType({ triciclo: null, moto: null, auto: null });
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

  /* ─── Reverse geocode map center for center pin ─── */
  useEffect(() => {
    if (selectionStep === 'done') {
      setCenterAddress(null);
      return;
    }
    setCenterAddressLoading(true);
    const timeout = setTimeout(async () => {
      try {
        const addr = await reverseGeocode(mapCenter.latitude, mapCenter.longitude);
        setCenterAddress(addr);
      } catch {
        setCenterAddress(null);
      } finally {
        setCenterAddressLoading(false);
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
      reverseGeocode(loc.latitude, loc.longitude).then((addr) => {
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
      reverseGeocode(loc.latitude, loc.longitude).then((addr) => {
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
    setIsScheduled(false);
    setScheduleDate('');
    setPromoCode('');
    setInsuranceSelected(false);
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
  }, [pickup?.latitude, pickup?.longitude, dropoff?.latitude, dropoff?.longitude]);

  async function handleRequest() {
    if (!pickup || !dropoff || !selectedEstimate) return;
    setIsRequesting(true);
    setError(null);
    try {
      const ride = await rideService.createRide({
        service_type: serviceType,
        payment_method: paymentMethod,
        pickup_latitude: pickup.latitude,
        pickup_longitude: pickup.longitude,
        pickup_address: `${pickup.label} — ${pickup.address}`,
        dropoff_latitude: dropoff.latitude,
        dropoff_longitude: dropoff.longitude,
        dropoff_address: `${dropoff.label} — ${dropoff.address}`,
        estimated_fare_cup: selectedEstimate.estimated_fare_cup,
        estimated_distance_m: selectedEstimate.estimated_distance_m,
        estimated_duration_s: selectedEstimate.estimated_duration_s,
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
        // W1.4: Insurance
        insurance_selected: insuranceSelected,
      });
      router.push(`/track/${ride.id}`);
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
              setPickupAddress(null);
              setSelectionStep('pickup');
              setEstimate(null);
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
              setDropoffAddress(null);
              setSelectionStep('dropoff');
              setEstimate(null);
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', opacity: pickup && dropoff ? 1 : 0.4, pointerEvents: pickup && dropoff ? 'auto' : 'none' }}>
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
                  const est = allEstimates[svc.slug];
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
                            {svc.desc}
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
                            <div style={{ fontWeight: 700, fontSize: '1rem', color: isSelected ? 'var(--primary)' : 'var(--text-primary)' }}>
                              {formatCUP(est.estimated_fare_cup)}
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
                <span
                  style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--primary)' }}
                >
                  {formatCUP(selectedEstimate.estimated_fare_cup)}
                </span>
              </div>
              <div
                className="booking-fare-details"
                style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem', color: 'var(--text-secondary)', flexWrap: 'wrap' }}
              >
                <span>{(selectedEstimate.estimated_distance_m / 1000).toFixed(1)} km</span>
                <span>{Math.round(selectedEstimate.estimated_duration_s / 60)} min</span>
                <span style={{ color: 'var(--text-tertiary)' }}>
                  ~${(selectedEstimate.estimated_fare_cup / 300).toFixed(2)} USD
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
              </>
              )}
            </div>

          {/* ═══ Promo code (W1.3) ═══ */}
          <div style={{ marginTop: '0.75rem' }}>
            <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
              Código promocional
            </label>
            <input
              type="text"
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
              placeholder="Ingresa un código"
              aria-label="Codigo promocional"
              style={{
                width: '100%',
                marginTop: '0.25rem',
                padding: '0.5rem',
                borderRadius: '0.5rem',
                border: '1px solid var(--border)',
                background: 'var(--bg-card)',
                fontSize: '0.85rem',
                boxSizing: 'border-box',
              }}
            />
          </div>


          {/* ═══ Scheduled ride (W1.2) ═══ */}
          <div style={{ marginTop: '0.75rem' }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                cursor: 'pointer',
              }}
            >
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
                  width: '100%',
                  marginTop: '0.5rem',
                  padding: '0.5rem',
                  borderRadius: '0.5rem',
                  border: '1px solid var(--border)',
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
                  ? `${t('book.request_ride', { defaultValue: 'Solicitar' })} ${(SERVICE_TYPE_KEYS.find(s => s.slug === serviceType)?.label || '')} \u00b7 ${formatCUP(selectedEstimate.estimated_fare_cup)}`
                  : t('book.request_ride', { defaultValue: 'Solicitar viaje' })
              }
            </button>
        </div>


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
                ? `${t('book.request_ride', { defaultValue: 'Solicitar' })} ${(SERVICE_TYPE_KEYS.find(s => s.slug === serviceType)?.label || '')} \u00b7 ${formatCUP(selectedEstimate.estimated_fare_cup)}`
                : t('book.request_ride', { defaultValue: 'Solicitar viaje' })
            }
          </button>
        </div>
    </main>
  );
}
