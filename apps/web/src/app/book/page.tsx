'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';
import { formatTRC, formatTRCasUSD, formatCUP, findNearestPreset, serviceTypeToVehicleType } from '@tricigo/utils';
import type { LocationPreset } from '@tricigo/utils';
import { rideService, nearbyService } from '@tricigo/api';
import type { FareEstimate, ServiceTypeSlug, PaymentMethod, NearbyVehicle } from '@tricigo/types';
import { useGeolocation } from '../../hooks/useGeolocation';
import { fetchRoute, reverseGeocode } from '../../services/geoService';

/* Dynamic import — Mapbox GL JS requires `window` */
const BookingMap = dynamic(() => import('./BookingMap'), {
  ssr: false,
  loading: () => (
    <div
      style={{
        height: 420,
        width: '100%',
        borderRadius: '0.75rem',
        border: '1px solid #333',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#1a1a2e',
        color: '#666',
        fontSize: '0.875rem',
      }}
    >
      Cargando mapa...
    </div>
  ),
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

  /* ─── Location state ─── */
  const [pickup, setPickup] = useState<LocationPreset | null>(null);
  const [dropoff, setDropoff] = useState<LocationPreset | null>(null);
  const [selectionStep, setSelectionStep] = useState<SelectionStep>('pickup');

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
    // Reverse geocode
    setPickupAddress(null);
    reverseGeocode(loc.latitude, loc.longitude).then((addr) => {
      if (addr) setPickupAddress(addr);
    });
    // Fetch route if dropoff already set
    if (dropoff) {
      loadRoute(loc, dropoff);
    }
  }

  function handleSetDropoff(loc: LocationPreset) {
    setDropoff(loc);
    setEstimate(null);
    setSelectionStep(pickup ? 'done' : 'pickup');
    // Reverse geocode
    setDropoffAddress(null);
    reverseGeocode(loc.latitude, loc.longitude).then((addr) => {
      if (addr) setDropoffAddress(addr);
    });
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
  }

  async function handleUseMyLocation() {
    try {
      const coords = await requestLocation();
      const preset = findNearestPreset(coords) ?? {
        label: t('book.map_custom_location'),
        address: `${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}`,
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
      });
      router.push(`/track/${ride.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('book.error_unknown');
      if (msg.includes('Not authenticated') || msg.includes('Missing')) {
        setError(t('book.error_auth'));
      } else {
        setError(t('book.error_request'));
      }
      console.error(err);
    } finally {
      setIsRequesting(false);
    }
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '1rem',
      }}
    >
      <div style={{ maxWidth: 500, width: '100%' }}>
        <Link
          href="/"
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
        <p style={{ color: '#888', marginBottom: '1.5rem' }}>{t('book.subtitle')}</p>

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
        />

        {/* ═══ Reset button ═══ */}
        {pickup && dropoff && (
          <button
            type="button"
            onClick={handleResetMap}
            style={{
              width: '100%',
              marginTop: '0.5rem',
              padding: '0.5rem',
              borderRadius: '0.5rem',
              border: '1px solid #ddd',
              background: 'white',
              cursor: 'pointer',
              fontSize: '0.8rem',
              color: '#666',
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
                      background: '#22c55e',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontWeight: 600 }}>{t('book.map_pickup_label')}:</span>
                  <span style={{ color: '#555' }}>{pickup.label}</span>
                </div>
                {pickupAddress && (
                  <p style={{ margin: '0.25rem 0 0 1.375rem', fontSize: '0.75rem', color: '#888' }}>
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
                      background: '#ef4444',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontWeight: 600 }}>{t('book.map_dropoff_label')}:</span>
                  <span style={{ color: '#555' }}>{dropoff.label}</span>
                </div>
                {dropoffAddress && (
                  <p style={{ margin: '0.25rem 0 0 1.375rem', fontSize: '0.75rem', color: '#888' }}>
                    {dropoffAddress}
                  </p>
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
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              {SERVICE_TYPE_KEYS.map((svc) => (
                <button
                  key={svc.slug}
                  type="button"
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
                        : '1px solid #ddd',
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
                      background: serviceType === svc.slug ? 'var(--primary)' : '#e5e5e5',
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
                <span style={{ fontSize: '0.875rem', color: '#666' }}>
                  {t('book.estimated_fare')}
                </span>
                <span
                  style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--primary)' }}
                >
                  {formatTRC(estimate.estimated_fare_trc)}
                </span>
              </div>
              <div
                style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem', color: '#666', flexWrap: 'wrap' }}
              >
                <span>{(estimate.estimated_distance_m / 1000).toFixed(1)} km</span>
                <span>{Math.round(estimate.estimated_duration_s / 60)} min</span>
                <span style={{ color: '#999' }}>
                  ~{formatTRCasUSD(estimate.estimated_fare_trc)}
                </span>
                <span style={{ color: '#999' }}>
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
                <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: '#999' }}>
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
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('cash')}
                    style={{
                      flex: 1,
                      padding: '0.5rem',
                      borderRadius: '0.5rem',
                      border:
                        paymentMethod === 'cash'
                          ? '2px solid var(--primary)'
                          : '1px solid #ddd',
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
                    style={{
                      flex: 1,
                      padding: '0.5rem',
                      borderRadius: '0.5rem',
                      border:
                        paymentMethod === 'tricicoin'
                          ? '2px solid var(--primary)'
                          : '1px solid #ddd',
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

              {/* Request button */}
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
            background: '#f9f9f9',
            borderRadius: '0.75rem',
            fontSize: '0.875rem',
            color: '#888',
            textAlign: 'center',
          }}
        >
          {t('book.download_cta')}
        </p>
      </div>
    </main>
  );
}
