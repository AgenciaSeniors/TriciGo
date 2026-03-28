'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';
import { formatTRC, formatTRCasUSD, formatCUP, findNearestPreset, serviceTypeToVehicleType } from '@tricigo/utils';
import type { LocationPreset } from '@tricigo/utils';
import { rideService, nearbyService, customerService } from '@tricigo/api';
import type { FareEstimate, ServiceTypeSlug, PaymentMethod, NearbyVehicle } from '@tricigo/types';
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

const SERVICE_TYPE_KEYS: { slug: ServiceTypeSlug; abbr: string; labelKey: string }[] = [
  { slug: 'triciclo_basico', abbr: 'TC', labelKey: 'book.service_triciclo' },
  { slug: 'moto_standard', abbr: 'MT', labelKey: 'book.service_moto' },
  { slug: 'auto_standard', abbr: 'AT', labelKey: 'book.service_auto' },
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
  const [isEstimating, setIsEstimating] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
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

  /* ─── Nearby vehicles state ─── */
  const [nearbyVehicles, setNearbyVehicles] = useState<NearbyVehicle[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);
  const realtimeChannelRef = useRef<ReturnType<typeof nearbyService.subscribeToDriverPositions> | null>(null);

  /* ─── Fetch nearby vehicles when pickup + serviceType change ─── */
  useEffect(() => {
    if (!pickup) {
      setNearbyVehicles([]);
      return;
    }

    let cancelled = false;
    const vehicleType = serviceTypeToVehicleType(serviceType);

    async function fetchVehicles() {
      setVehiclesLoading(true);
      try {
        const vehicles = await nearbyService.findNearbyVehicles({
          lat: pickup!.latitude,
          lng: pickup!.longitude,
          vehicleType,
          radiusM: 5000,
          limit: 50,
        });
        if (!cancelled) setNearbyVehicles(vehicles);
      } catch (err) {
        console.warn('Failed to fetch nearby vehicles:', err);
        if (!cancelled) setNearbyVehicles([]);
      } finally {
        if (!cancelled) setVehiclesLoading(false);
      }
    }

    fetchVehicles();
    return () => { cancelled = true; };
  }, [pickup, serviceType]);

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
  }

  function handleSetDropoff(loc: LocationPreset) {
    setDropoff(loc);
    setEstimate(null);
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
  }

  function handleResetMap() {
    setPickup(null);
    setDropoff(null);
    setEstimate(null);
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

  async function handleRequest() {
    if (!pickup || !dropoff || !estimate) return;
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
        estimated_fare_cup: estimate.estimated_fare_cup,
        estimated_distance_m: estimate.estimated_distance_m,
        estimated_duration_s: estimate.estimated_duration_s,
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
        />

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
                  background: '#FFF5F0',
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
          {/* ═══ Service type selector ═══ */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.875rem',
                fontWeight: 600,
                marginBottom: '0.5rem',
              }}
            >
              {t('book.service_type')}
            </label>
            <div className="booking-service-types">
              {SERVICE_TYPE_KEYS.map((svc) => (
                <button
                  key={svc.slug}
                  type="button"
                  className="booking-service-btn"
                  onClick={() => {
                    setServiceType(svc.slug);
                    setEstimate(null);
                  }}
                  style={{
                    flex: 1,
                    padding: '0.75rem',
                    borderRadius: '0.75rem',
                    border:
                      serviceType === svc.slug
                        ? '2px solid var(--primary)'
                        : '1px solid var(--border)',
                    background: serviceType === svc.slug ? '#FFF5F0' : 'white',
                    cursor: 'pointer',
                    textAlign: 'center',
                    fontSize: '0.875rem',
                    fontWeight: serviceType === svc.slug ? 700 : 400,
                  }}
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '2rem',
                      height: '2rem',
                      borderRadius: '50%',
                      background: serviceType === svc.slug ? 'var(--primary)' : 'var(--border)',
                      color: serviceType === svc.slug ? 'white' : '#666',
                      fontWeight: 700,
                      fontSize: '0.7rem',
                      marginBottom: '0.25rem',
                    }}
                  >
                    {svc.abbr}
                  </span>
                  {t(svc.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* ═══ Estimate button ═══ */}
          <button
            disabled={!canEstimate || isEstimating}
            onClick={handleEstimate}
            aria-label="Calcular tarifa estimada"
            style={{
              width: '100%',
              padding: '1rem',
              borderRadius: '0.75rem',
              border: 'none',
              background: canEstimate && !isEstimating ? 'var(--primary)' : '#ccc',
              color: 'white',
              fontSize: '1rem',
              fontWeight: 600,
              cursor: canEstimate && !isEstimating ? 'pointer' : 'not-allowed',
              marginTop: '0.5rem',
            }}
          >
            {isEstimating ? t('book.estimating') : t('book.get_estimate')}
          </button>

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
          {estimate && (
            <div
              className="booking-estimate-card"
              style={{
                padding: '1.25rem',
                borderRadius: '0.75rem',
                border: '2px solid var(--primary)',
                background: '#FFF5F0',
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
                <span
                  style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--primary)' }}
                >
                  {formatTRC(estimate.estimated_fare_trc)}
                </span>
              </div>
              <div
                className="booking-fare-details"
                style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem', color: 'var(--text-secondary)', flexWrap: 'wrap' }}
              >
                <span>{(estimate.estimated_distance_m / 1000).toFixed(1)} km</span>
                <span>{Math.round(estimate.estimated_duration_s / 60)} min</span>
                <span style={{ color: 'var(--text-tertiary)' }}>
                  ~{formatTRCasUSD(estimate.estimated_fare_trc)}
                </span>
                <span style={{ color: 'var(--text-tertiary)' }}>
                  ≈ {formatCUP(estimate.estimated_fare_cup)}
                </span>
                {estimate.surge_multiplier > 1 && (
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
                    {estimate.surge_multiplier.toFixed(1)}x {t('book.surge_active')}
                  </span>
                )}
              </div>
              {estimate.per_km_rate_cup > 0 && (
                <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                  {t('book.per_km_rate', {
                    rate: formatCUP(estimate.per_km_rate_cup),
                  })}
                </p>
              )}
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: '#bbb' }}>
                1 USD = {estimate.exchange_rate_usd_cup} CUP
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

              {/* ═══ Insurance toggle (W1.4) ═══ */}
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginTop: '0.75rem',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={insuranceSelected}
                  onChange={(e) => setInsuranceSelected(e.target.checked)}
                  aria-label="Agregar seguro de viaje"
                />
                <span style={{ fontSize: '0.85rem' }}>Seguro de viaje (+$0.50 USD)</span>
              </label>

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

              {/* Request button */}
              <button
                onClick={handleRequest}
                disabled={isRequesting}
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
                  marginTop: '1rem',
                }}
              >
                {isRequesting ? t('book.requesting') : t('book.request_ride')}
              </button>
            </div>
          )}
        </div>

        <p
          style={{
            marginTop: '2rem',
            padding: '1rem',
            background: 'var(--bg-page)',
            borderRadius: '0.75rem',
            fontSize: '0.875rem',
            color: 'var(--text-tertiary)',
            textAlign: 'center',
          }}
        >
          {t('book.download_cta')}
        </p>

        {/* Spacer for fixed bottom CTA on mobile */}
        {estimate && <div style={{ height: '5rem' }} className="booking-cta-spacer" />}
      </div>

      {/* Fixed bottom CTA on mobile */}
      {estimate && (
        <div className="booking-cta-fixed">
          <button
            onClick={handleRequest}
            disabled={isRequesting}
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
            {isRequesting ? t('book.requesting') : t('book.request_ride')}
          </button>
        </div>
      )}
    </main>
  );
}
