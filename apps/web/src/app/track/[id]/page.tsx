'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, rideService, deliveryService, reviewService, nearbyService, trustedContactService, incidentService } from '@tricigo/api';
import { formatCUP } from '@tricigo/utils';
import type { RideWithDriver, RideStatus } from '@tricigo/types';
import { useDriverPosition } from '../../../hooks/useDriverPosition';
import { useRiderLocationSharing } from '../../../hooks/useRiderLocationSharing';
import { fetchRoute } from '../../../services/geoService';
import { TipFlow } from '../../../components/TipFlow';
import './track.css';

const TrackingMap = dynamic(() => import('../TrackingMap'), {
  ssr: false,
  loading: () => (
    <div style={{ width: '100%', height: '300px', background: 'var(--bg-light)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>Cargando mapa...</span>
    </div>
  ),
});

/* ── SVG Icons ── */
const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
);
const IconX = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
);
const IconAlert = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
);
const IconShare = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
);
const IconWhatsApp = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" /></svg>
);
const IconStar = ({ filled }: { filled: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill={filled ? '#F59E0B' : 'none'} stroke={filled ? '#F59E0B' : '#d1d5db'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
);
const IconClock = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
);
const IconArrowLeft = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
);
const IconPackage = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21" /><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>
);

/* ── Status Steps Hook ── */
function useStatusSteps() {
  const { t } = useTranslation('web');
  return useMemo(() => [
    { key: 'searching' as RideStatus, label: t('track.step_searching', { defaultValue: 'Buscando el mejor conductor para ti...' }), stepNumber: 1 },
    { key: 'accepted' as RideStatus, label: t('track.step_accepted', { defaultValue: 'Conductor asignado' }), stepNumber: 2 },
    { key: 'driver_en_route' as RideStatus, label: t('track.step_en_route', { defaultValue: 'En camino a recogerte' }), stepNumber: 3 },
    { key: 'arrived_at_pickup' as RideStatus, label: t('track.step_arrived', { defaultValue: 'Llego al punto' }), stepNumber: 4 },
    { key: 'in_progress' as RideStatus, label: t('track.step_in_progress', { defaultValue: 'Viaje en curso' }), stepNumber: 5 },
    { key: 'arrived_at_destination' as RideStatus, label: t('track.step_arrived_destination', { defaultValue: 'Llegando a destino' }), stepNumber: 6 },
    { key: 'completed' as RideStatus, label: t('track.step_completed', { defaultValue: 'Viaje completado' }), stepNumber: 7 },
  ], [t]);
}

/* ── Rating Stars ── */
function RatingStars({ rating }: { rating: number }) {
  return (
    <span className="track-driver-rating">
      {[1, 2, 3, 4, 5].map((i) => (
        <IconStar key={i} filled={i <= Math.round(rating)} />
      ))}
      <span style={{ marginLeft: 4 }}>{rating.toFixed(1)}</span>
    </span>
  );
}

/* ── Vertical Status Stepper ── */
function StatusStepper({ steps, currentIdx }: { steps: { key: string; label: string; stepNumber: number }[]; currentIdx: number }) {
  return (
    <div className="track-stepper">
      {steps.map((step, idx) => {
        const isDone = idx < currentIdx;
        const isActive = idx === currentIdx;
        return (
          <div key={step.key} className="track-stepper-step">
            <div className="track-stepper-indicator">
              <div className={`track-stepper-dot ${isDone ? 'track-stepper-dot--done' : isActive ? 'track-stepper-dot--active' : 'track-stepper-dot--pending'}`}>
                {isDone ? <IconCheck /> : step.stepNumber}
              </div>
              {idx < steps.length - 1 && (
                <div className={`track-stepper-line ${isDone ? 'track-stepper-line--done' : 'track-stepper-line--pending'}`} />
              )}
            </div>
            <span className={`track-stepper-label ${isActive ? 'track-stepper-label--active' : isDone ? 'track-stepper-label--done' : ''}`}>
              {step.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Main Page ── */
export default function TrackRidePage() {
  const { t } = useTranslation('web');
  const params = useParams();
  const router = useRouter();
  const rideId = params.id as string;

  // Auth guard (BUG-004 fix)
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!authLoading && !userId) router.replace('/login');
  }, [authLoading, userId, router]);

  const [ride, setRide] = useState<RideWithDriver | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [deliveryDetails, setDeliveryDetails] = useState<{
    recipient_name?: string; recipient_phone?: string; package_description?: string;
    package_category?: string; estimated_weight_kg?: number; client_accompanies?: boolean;
    pickup_photo_url?: string | null; delivery_photo_url?: string | null;
  } | null>(null);
  const statusSteps = useStatusSteps();

  // Driver position via polling RPC (BUG-277 — the broadcast channel is dead;
  // the GPS loop only writes via update_driver_position). Active only while a
  // driver is assigned and the ride is in flight.
  const driverActive = !!ride && ['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress'].includes(ride.status);
  const driverPos = useDriverPosition(ride?.driver_id, driverActive);
  const driverLocation = driverPos.position ? { lat: driverPos.position.latitude, lng: driverPos.position.longitude } : null;

  // Share the rider's location with the driver during the pickup phase so the
  // driver app shows the rider's pin (parity con useRiderLocationSharing móvil).
  useRiderLocationSharing(ride?.id, ride?.status, userId);

  // Dynamic ETA (min) recomputed from the driver's live position toward the
  // current target (pickup before in_progress, dropoff during the trip).
  const [dynamicEtaMin, setDynamicEtaMin] = useState<number | null>(null);

  // Nearby vehicles (shown during searching)
  const [nearbyVehicles, setNearbyVehicles] = useState<Array<{ latitude: number; longitude: number; heading?: number | null; vehicle_type?: string }>>([]);

  // Review form state
  const [rating, setRating] = useState(0);
  const [reviewComment, setReviewComment] = useState('');
  const [reviewTags, setReviewTags] = useState<string[]>([]);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);

  const handleSubmitReview = async () => {
    if (!rating || !ride?.driver_id || !userId) return;
    setReviewSubmitting(true);
    try {
      // Fold the selected categorized tags into the comment (parity with the
      // mobile RideCompleteView tag chips; reviewService has no tags column).
      const tagsText = reviewTags.length ? `[${reviewTags.join(', ')}] ` : '';
      const combinedComment = (tagsText + reviewComment.trim()).trim();
      await reviewService.submitReview({
        ride_id: rideId,
        reviewer_id: userId,
        reviewee_id: ride.driver_id,
        rating: rating as 1 | 2 | 3 | 4 | 5,
        comment: combinedComment || undefined,
      });
      setReviewSubmitted(true);
    } catch (err) {
      console.error('Review submission failed:', err);
    } finally {
      setReviewSubmitting(false);
    }
  };

  const fetchRide = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await rideService.getRideWithDriver(rideId);
      if (data) setRide(data);
      else setError(t('track.not_found', { defaultValue: 'Viaje no encontrado' }));
    } catch {
      setError(t('track.error_loading', { defaultValue: 'Error al cargar el viaje' }));
    } finally {
      setLoading(false);
    }
  }, [rideId, t, userId]);

  const rideStatusRef = useRef(ride?.status);
  rideStatusRef.current = ride?.status;

  useEffect(() => {
    fetchRide();
    // BUG-277-web: subscribeToRide is now a no-op that returns { unsubscribe }
    // (the realtime websocket was disabled to free OkHttp pool slots in mobile;
    // web inherits the no-op via the shared `@tricigo/api` package). The
    // polling interval below is the sole source of ride state updates now.
    // We keep the call so future re-enabling is a one-line flip.
    const channel = rideService.subscribeToRide(rideId, (updated) => {
      setRide((prev) => {
        if (!prev) return null;
        return { ...prev, ...updated, pickup_location: prev.pickup_location, dropoff_location: prev.dropoff_location };
      });
    });
    // Match mobile (apps/client/src/hooks/useRide.ts:241): 3s polling.
    // Web was at 10s — that's 3.3x slower at detecting completed status,
    // so the user spent up to 10s on the in-progress screen before the
    // rating screen appeared. Same network cost as mobile, identical UX.
    const TERMINAL = ['completed', 'canceled', 'failed', 'no_driver_found', 'disputed'];
    const interval = setInterval(() => {
      if (TERMINAL.includes(rideStatusRef.current ?? '')) {
        clearInterval(interval);
        return;
      }
      fetchRide();
    }, 3_000);
    // Re-fetch immediately when the tab/window comes back into focus —
    // mirrors the AppState 'foreground' listener in mobile useRide.ts:244-248.
    // Without this, a user who switched tabs for 30s would see stale ride
    // state until the next polling tick.
    const onVisible = () => {
      if (!document.hidden && !TERMINAL.includes(rideStatusRef.current ?? '')) {
        fetchRide();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      channel.unsubscribe();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rideId, fetchRide]);

  // Poll nearby vehicles during searching status
  useEffect(() => {
    if (ride?.status !== 'searching') {
      setNearbyVehicles([]);
      return;
    }
    const lat = typeof ride.pickup_location === 'object' ? ride.pickup_location.latitude : 0;
    const lng = typeof ride.pickup_location === 'object' ? ride.pickup_location.longitude : 0;
    if (!lat || !lng) return;

    const fetchNearby = async () => {
      try {
        const vehicles = await nearbyService.findNearbyVehicles({ lat, lng, radiusM: 5000, limit: 20 });
        setNearbyVehicles(vehicles);
      } catch { /* non-critical */ }
    };

    fetchNearby();
    const interval = setInterval(fetchNearby, 5000);
    return () => clearInterval(interval);
  }, [ride?.status, ride?.pickup_location]);

  useEffect(() => {
    if (!ride || ride.ride_mode !== 'cargo') return;
    deliveryService.getDeliveryDetails(rideId).then((d) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (d) setDeliveryDetails(d as any);
    }).catch(() => {});
  }, [ride?.ride_mode, rideId]);

  // Dynamic ETA: throttled OSRM route from the driver's live position to the
  // current target. Mirrors the mobile client's useETA (recompute on driver
  // movement, ~30s throttle). Falls back to the static estimate when we have
  // no live position yet.
  const etaThrottleRef = useRef(0);
  useEffect(() => {
    if (!ride || !driverLocation || !driverActive) { setDynamicEtaMin(null); return; }
    const now = Date.now();
    if (now - etaThrottleRef.current < 30_000) return;
    etaThrottleRef.current = now;
    const inProgress = ride.status === 'in_progress';
    const pLat = typeof ride.pickup_location === 'object' ? ride.pickup_location.latitude : 0;
    const pLng = typeof ride.pickup_location === 'object' ? ride.pickup_location.longitude : 0;
    const dLat = typeof ride.dropoff_location === 'object' ? ride.dropoff_location.latitude : 0;
    const dLng = typeof ride.dropoff_location === 'object' ? ride.dropoff_location.longitude : 0;
    const target = inProgress ? { lat: dLat, lng: dLng } : { lat: pLat, lng: pLng };
    if (!target.lat || !target.lng) return;
    let cancelled = false;
    fetchRoute({ lat: driverLocation.lat, lng: driverLocation.lng }, target)
      .then((r) => { if (!cancelled && r) setDynamicEtaMin(Math.max(1, Math.ceil(r.duration_s / 60))); })
      .catch(() => { /* keep last ETA */ });
    return () => { cancelled = true; };
  }, [ride, driverLocation, driverActive]);

  /* ── Loading State ── */
  // Auth gate — block render until authenticated (BUG-004 fix)
  if (authLoading || !userId) {
    return (
      <div className="track-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </div>
          <p style={{ fontSize: '0.875rem' }}>Cargando...</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="track-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: '#00C853' }}>Go</span>
          </div>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>Cargando datos del viaje...</p>
        </div>
      </div>
    );
  }

  /* ── Error State ── */
  if (error || !ride) {
    return (
      <div className="track-page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(239,68,68,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <IconX />
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>{error ?? t('track.not_found', { defaultValue: 'Viaje no encontrado' })}</p>
        <Link href="/" className="track-back-link"><IconArrowLeft /> {t('track.back_home', { defaultValue: 'Volver al inicio' })}</Link>
      </div>
    );
  }

  const currentStepIdx = statusSteps.findIndex((s) => s.key === ride.status);
  const isCanceled = ride.status === 'canceled';
  const isDisputed = ride.status === 'disputed';
  const isTerminal = isCanceled || isDisputed || ride.status === 'completed';

  const pickupLat = typeof ride.pickup_location === 'object' ? ride.pickup_location.latitude : 0;
  const pickupLng = typeof ride.pickup_location === 'object' ? ride.pickup_location.longitude : 0;
  const dropoffLat = typeof ride.dropoff_location === 'object' ? ride.dropoff_location.latitude : 0;
  const dropoffLng = typeof ride.dropoff_location === 'object' ? ride.dropoff_location.longitude : 0;

  const statusBadgeClass = isCanceled ? 'track-status-badge--canceled'
    : ride.status === 'completed' ? 'track-status-badge--completed'
    : ride.status === 'searching' ? 'track-status-badge--searching'
    : 'track-status-badge--active';

  const statusLabel = isCanceled ? t('track.canceled', { defaultValue: 'Cancelado' })
    : isDisputed ? t('track.disputed', { defaultValue: 'En disputa' })
    : ride.status === 'completed' ? t('track.step_completed', { defaultValue: 'Completado' })
    : ride.status === 'searching' ? t('track.step_searching', { defaultValue: 'Buscando' })
    : t('track.step_in_progress', { defaultValue: 'En curso' });

  return (
    <div className="track-page">
      <div className="track-layout">
        {/* ═══ LEFT: Map Hero ═══ */}
        <div className="track-map-hero">
          <TrackingMap
            pickupLat={pickupLat}
            pickupLng={pickupLng}
            dropoffLat={dropoffLat}
            dropoffLng={dropoffLng}
            driverLat={driverLocation?.lat}
            driverLng={driverLocation?.lng}
            vehicleType={ride.vehicle_type ?? undefined}
            nearbyVehicles={nearbyVehicles}
            rideStatus={ride.status}
            style={{ width: '100%', height: '100%', borderRadius: 0 }}
          />

          {/* ETA Badge floating on map — dynamic (from live driver position) when available */}
          {!isTerminal && (dynamicEtaMin != null || ride.estimated_duration_s > 0) && (
            <div className="track-eta-badge">
              <IconClock />
              <span>
                ~{dynamicEtaMin ?? Math.ceil(ride.estimated_duration_s / 60)} min
                {dynamicEtaMin != null && (
                  <span style={{ opacity: 0.7, marginLeft: 4 }}>
                    {ride.status === 'in_progress' ? t('track.eta_to_dest', { defaultValue: 'a destino' }) : t('track.eta_to_pickup', { defaultValue: 'al punto' })}
                  </span>
                )}
              </span>
            </div>
          )}

          {/* Nearby drivers count during searching */}
          {ride.status === 'searching' && (
            <div style={{ position: 'absolute', bottom: 16, left: 16, background: 'rgba(0,0,0,0.7)', color: '#fff', padding: '6px 12px', borderRadius: 20, fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: nearbyVehicles.length > 0 ? '#00C853' : 'var(--primary, #FF4D00)',
                display: 'inline-block',
                animation: nearbyVehicles.length === 0 ? 'searchPulse 1.5s ease-in-out infinite' : 'none',
              }} />
              {nearbyVehicles.length > 0
                ? `${nearbyVehicles.length} conductor${nearbyVehicles.length > 1 ? 'es' : ''} cerca`
                : 'Buscando conductores cercanos...'}
            </div>
          )}
        </div>

        {/* ═══ RIGHT: Info Panel ═══ */}
        <div className="track-panel">
          {/* Header */}
          <div>
            <Link href="/" className="track-back-link"><IconArrowLeft /> {t('track.back_home', { defaultValue: 'Volver al inicio' })}</Link>
          </div>

          <div className="track-panel-header">
            <div>
              <h1 className="track-panel-title">
                {ride.ride_mode === 'cargo' ? 'Seguimiento de envio' : t('track.title', { defaultValue: 'Seguimiento de viaje' })}
              </h1>
              <span className="track-panel-id">ID: {ride.id.slice(0, 8)}</span>
            </div>
            <span className={`track-status-badge ${statusBadgeClass}`}>{statusLabel}</span>
          </div>

          {/* Status Stepper or Canceled/Disputed */}
          {isCanceled ? (
            <div className="track-canceled-card track-card">
              <div className="track-canceled-icon"><IconX /></div>
              <div className="track-canceled-title">{t('track.canceled', { defaultValue: 'Viaje cancelado' })}</div>
              {ride.cancellation_reason && (
                <div className="track-canceled-reason">{ride.cancellation_reason}</div>
              )}
            </div>
          ) : isDisputed ? (
            <div className="track-disputed-card track-card">
              <div className="track-canceled-icon" style={{ background: 'rgba(245,158,11,0.1)' }}>
                <IconAlert />
              </div>
              <div className="track-canceled-title">{t('track.disputed', { defaultValue: 'Viaje en disputa' })}</div>
            </div>
          ) : (
            <div className="track-card">
              <StatusStepper steps={statusSteps} currentIdx={currentStepIdx} />
            </div>
          )}

          {/* Tracking health banner — parity con los banners de RideActiveView */}
          {driverActive && (driverPos.isStale || !driverPos.position) && (
            <div className="track-card" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: '#f59e0b', flexShrink: 0 }}><IconAlert /></span>
              <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                {!driverPos.position
                  ? t('track.waiting_driver_location', { defaultValue: 'Esperando la ubicación del conductor...' })
                  : t('track.signal_stale', { defaultValue: 'La señal del conductor está intermitente. Mostrando su última ubicación conocida.' })}
              </span>
            </div>
          )}

          {/* Ride Completion + Rating */}
          {ride.status === 'completed' && !reviewSubmitted && ride.driver_id && (
            <div className="track-card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🎉</div>
              <h3 style={{ fontSize: '1.125rem', fontWeight: 700, marginBottom: '0.25rem' }}>
                {t('track.ride_completed', { defaultValue: '¡Viaje completado!' })}
              </h3>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                {t('track.rate_driver', { defaultValue: '¿Cómo fue tu experiencia con el conductor?' })}
              </p>

              {/* Star Rating */}
              <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    onClick={() => setRating(star)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: '2rem',
                      color: star <= rating ? '#F59E0B' : '#D1D5DB',
                      transition: 'color 0.15s',
                      padding: '0.25rem',
                    }}
                    aria-label={`${star} estrellas`}
                  >
                    ★
                  </button>
                ))}
              </div>

              {/* Comment + Submit */}
              {rating > 0 && (
                <>
                  {/* Categorized rating tags (adapt to score) — parity con RideCompleteView */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', justifyContent: 'center', marginBottom: '0.75rem' }}>
                    {(rating >= 4
                      ? [t('track.tag_punctual', { defaultValue: 'Puntual' }), t('track.tag_kind', { defaultValue: 'Amable' }), t('track.tag_safe', { defaultValue: 'Conducción segura' }), t('track.tag_clean', { defaultValue: 'Vehículo limpio' })]
                      : [t('track.tag_late', { defaultValue: 'Tardó mucho' }), t('track.tag_rough', { defaultValue: 'Conducción brusca' }), t('track.tag_unkind', { defaultValue: 'Poco amable' }), t('track.tag_dirty', { defaultValue: 'Vehículo sucio' })]
                    ).map((tag) => {
                      const on = reviewTags.includes(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => setReviewTags((prev) => prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag])}
                          style={{
                            padding: '0.35rem 0.7rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
                            border: on ? '2px solid var(--primary)' : '1px solid var(--border)',
                            background: on ? 'rgba(255,77,0,0.08)' : 'var(--bg-card)',
                            color: on ? 'var(--primary)' : 'var(--text-secondary)',
                          }}
                        >
                          {tag}
                        </button>
                      );
                    })}
                  </div>
                  <textarea
                    value={reviewComment}
                    onChange={(e) => setReviewComment(e.target.value)}
                    placeholder={t('track.review_placeholder', { defaultValue: 'Comentario opcional...' })}
                    rows={2}
                    style={{
                      width: '100%',
                      padding: '0.75rem',
                      borderRadius: 'var(--radius-md, 8px)',
                      border: '1px solid var(--border-light, #e5e7eb)',
                      fontSize: '0.875rem',
                      resize: 'none',
                      marginBottom: '0.75rem',
                    }}
                  />
                  <button
                    onClick={handleSubmitReview}
                    disabled={reviewSubmitting}
                    style={{
                      width: '100%',
                      padding: '0.75rem',
                      borderRadius: 'var(--radius-md, 8px)',
                      background: 'var(--primary, #00C853)',
                      color: '#fff',
                      fontWeight: 700,
                      fontSize: '0.9375rem',
                      border: 'none',
                      cursor: reviewSubmitting ? 'not-allowed' : 'pointer',
                      opacity: reviewSubmitting ? 0.6 : 1,
                    }}
                  >
                    {reviewSubmitting
                      ? t('track.submitting_review', { defaultValue: 'Enviando...' })
                      : t('track.submit_review', { defaultValue: 'Enviar calificación' })}
                  </button>
                </>
              )}
            </div>
          )}

          {/* Thank you after review */}
          {ride.status === 'completed' && reviewSubmitted && (
            <div className="track-card" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>✅</div>
              <h3 style={{ fontSize: '1.125rem', fontWeight: 700, marginBottom: '0.25rem' }}>
                {t('track.review_thanks', { defaultValue: '¡Gracias por tu calificación!' })}
              </h3>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                {t('track.review_helps', { defaultValue: 'Tu opinión ayuda a mejorar la experiencia.' })}
              </p>
            </div>
          )}

          {/* Propina post-viaje — parity con RideCompleteView (no en efectivo, sin propina previa) */}
          {ride.status === 'completed' && ride.payment_method !== 'cash' && !ride.tip_amount && userId && (
            <TipFlow rideId={ride.id} userId={userId} onTipSubmitted={fetchRide} />
          )}

          {/* Route Card */}
          <div className="track-card">
            <div className="track-route">
              <div className="track-route-dots">
                <div className="track-route-dot track-route-dot--pickup" />
                <div className="track-route-line" />
                <div className="track-route-dot track-route-dot--dropoff" />
              </div>
              <div className="track-route-addresses">
                <div>
                  <div className="track-route-label">{t('track.from', { defaultValue: 'Desde' })}</div>
                  <div className="track-route-address">{ride.pickup_address}</div>
                </div>
                <div>
                  <div className="track-route-label">{t('track.to', { defaultValue: 'Hasta' })}</div>
                  <div className="track-route-address">{ride.dropoff_address}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Driver Card — clickable when we have the driver_user_id, mirroring
              the mobile app's tap-on-driver-card → /driver-profile/[userId] flow. */}
          {ride.driver_name && (
            <div className="track-card">
              <div className="track-route-label" style={{ marginBottom: 10 }}>{t('track.your_driver', { defaultValue: 'Tu conductor' })}</div>
              {ride.driver_user_id ? (
                <Link
                  href={`/driver-profile/${ride.driver_user_id}`}
                  className="track-driver"
                  style={{ textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}
                  aria-label={t('track.view_driver_profile', { defaultValue: 'Ver perfil del conductor' })}
                >
                  <div className="track-driver-avatar">
                    {ride.driver_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="track-driver-info">
                    <div className="track-driver-name">{ride.driver_name}</div>
                    {ride.vehicle_make && (
                      <div className="track-driver-vehicle">
                        {ride.vehicle_color} {ride.vehicle_make} {ride.vehicle_model}
                      </div>
                    )}
                    {ride.driver_rating && <RatingStars rating={ride.driver_rating} />}
                    {ride.vehicle_plate && (
                      <div className="track-driver-plate">{ride.vehicle_plate}</div>
                    )}
                  </div>
                  <span aria-hidden="true" style={{ marginLeft: 'auto', color: 'var(--text-tertiary)' }}>›</span>
                </Link>
              ) : (
                <div className="track-driver">
                  <div className="track-driver-avatar">
                    {ride.driver_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="track-driver-info">
                    <div className="track-driver-name">{ride.driver_name}</div>
                    {ride.vehicle_make && (
                      <div className="track-driver-vehicle">
                        {ride.vehicle_color} {ride.vehicle_make} {ride.vehicle_model}
                      </div>
                    )}
                    {ride.driver_rating && <RatingStars rating={ride.driver_rating} />}
                    {ride.vehicle_plate && (
                      <div className="track-driver-plate">{ride.vehicle_plate}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Delivery Details */}
          {ride.ride_mode === 'cargo' && deliveryDetails && (
            <div className="track-card track-delivery-card">
              <div className="track-delivery-header">
                <IconPackage />
                <span>Detalles del envio</span>
                {deliveryDetails.client_accompanies && (
                  <span className="track-delivery-badge">Acompanando</span>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-sm)' }}>
                {deliveryDetails.recipient_name && (
                  <div className="track-delivery-row"><span>Destinatario: </span><strong>{deliveryDetails.recipient_name}</strong></div>
                )}
                {deliveryDetails.recipient_phone && (
                  <div className="track-delivery-row"><span>Telefono: </span>{deliveryDetails.recipient_phone}</div>
                )}
                {deliveryDetails.package_description && (
                  <div className="track-delivery-row"><span>Paquete: </span>{deliveryDetails.package_description}</div>
                )}
                <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                  {deliveryDetails.package_category && (
                    <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, background: 'rgba(255,77,0,0.1)', color: 'var(--primary)', padding: '3px 10px', borderRadius: 'var(--radius-full)' }}>
                      {deliveryDetails.package_category.replace(/_/g, ' ')}
                    </span>
                  )}
                  {deliveryDetails.estimated_weight_kg && (
                    <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>{deliveryDetails.estimated_weight_kg} kg</span>
                  )}
                </div>
              </div>
              {(deliveryDetails.pickup_photo_url || deliveryDetails.delivery_photo_url) && (
                <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                  {deliveryDetails.pickup_photo_url && (
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 4 }}>Foto recogida</div>
                      <img src={deliveryDetails.pickup_photo_url} alt="Pickup" style={{ width: '100%', height: 100, objectFit: 'cover', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-light)' }} />
                    </div>
                  )}
                  {deliveryDetails.delivery_photo_url && (
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 4 }}>Foto entrega</div>
                      <img src={deliveryDetails.delivery_photo_url} alt="Delivery" style={{ width: '100%', height: 100, objectFit: 'cover', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-light)' }} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Fare Card */}
          <div className="track-card">
            <div className="track-fare">
              <span className="track-fare-label">
                {isTerminal ? t('track.final_fare', { defaultValue: 'Tarifa final' }) : t('track.estimated_fare', { defaultValue: 'Tarifa estimada' })}
              </span>
              <span className="track-fare-amount">
                {formatCUP(ride.final_fare_cup ?? ride.estimated_fare_cup)}
              </span>
            </div>
          </div>

          {/* Action Buttons */}
          {!isTerminal && (
            <div className="track-actions">
              {ride.share_token && (
                <button
                  className="track-action-btn track-action-btn--share"
                  onClick={() => {
                    const url = `https://tricigo.com/track/share/${ride.share_token}`;
                    navigator.clipboard.writeText(url).then(() => {
                      setShareCopied(true);
                      setTimeout(() => setShareCopied(false), 2000);
                    });
                  }}
                >
                  {shareCopied ? <><IconCheck /> Enlace copiado</> : <><IconShare /> Compartir viaje</>}
                </button>
              )}
              {ride.driver_phone && (
                <a
                  className="track-action-btn track-action-btn--whatsapp"
                  href={`https://wa.me/${ride.driver_phone.replace(/[^0-9]/g, '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <IconWhatsApp /> Contactar
                </a>
              )}
              {['searching', 'accepted', 'driver_en_route'].includes(ride.status) && (
                <button
                  className="track-action-btn track-action-btn--cancel"
                  disabled={canceling}
                  onClick={async () => {
                    // Status-aware cancel preview: a fee typically applies only once
                    // the driver is en route. Mirrors the mobile cancel sheet copy.
                    const mayCharge = ride.status === 'driver_en_route';
                    const confirmMsg = mayCharge
                      ? t('track.cancel_confirm_fee', { defaultValue: 'El conductor ya está en camino. Cancelar ahora puede aplicar una tarifa de cancelación. ¿Continuar?' })
                      : t('track.cancel_confirm_free', { defaultValue: '¿Seguro que quieres cancelar este viaje? Aún no se aplica ninguna tarifa.' });
                    if (!confirm(confirmMsg)) return;
                    setCanceling(true);
                    try {
                      await rideService.cancelRide(rideId, userId ?? undefined, 'rider_canceled');
                      setCanceling(false);
                    } catch {
                      // Reset on error so user can retry
                    } finally {
                      setCanceling(false);
                    }
                  }}
                >
                  {canceling ? t('track.canceling', { defaultValue: 'Cancelando...' }) : <>{t('track.cancel_ride', { defaultValue: 'Cancelar viaje' })}</>}
                </button>
              )}

              {/* SOS button — visible cuando hay un conductor asignado o
                  el viaje está en marcha. Espejo del SOS de mobile
                  (RideActiveView.tsx:handleSOS). Tres acciones cascada:
                    1. createSOSReport      → registra incidente en DB
                    2. broadcastEmergency   → SMS automático a contactos
                                              de confianza con auto_share
                    3. tel:106              → línea cubana (policía)

                  Confirm dialog para evitar tap accidental. Best-effort
                  en (1) y (2) — si fallan, (3) siempre se ejecuta. */}
              {['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress'].includes(ride.status) && (
                <button
                  type="button"
                  className="track-action-btn track-action-btn--sos"
                  style={{
                    background: '#dc2626',
                    color: 'white',
                    fontWeight: 700,
                    border: 0,
                  }}
                  onClick={async () => {
                    if (!userId) return;
                    if (!confirm(t('track.sos_confirm', {
                      defaultValue: 'Vas a llamar a emergencias y avisar a tus contactos de confianza por SMS. ¿Confirmás?',
                    }))) return;
                    // Best-effort: run report + broadcast in parallel,
                    // ignore failures, ALWAYS open tel:106 last so the
                    // dialer launches even if the API calls hang.
                    // Coords priority: live driver location (from realtime
                    // channel) → pickup_location (always present on the
                    // ride) → 0,0 fallback. Trusted contacts get the
                    // most accurate coord we have at the moment of SOS.
                    const pickupLatLive = typeof ride.pickup_location === 'object' ? ride.pickup_location.latitude : 0;
                    const pickupLngLive = typeof ride.pickup_location === 'object' ? ride.pickup_location.longitude : 0;
                    const lat = driverLocation?.lat ?? pickupLatLive;
                    const lng = driverLocation?.lng ?? pickupLngLive;
                    Promise.allSettled([
                      incidentService.createSOSReport({
                        ride_id: ride.id,
                        reported_by: userId,
                        against_user_id: ride.driver_id ?? undefined,
                        description: 'SOS activado por pasajero (web) durante viaje',
                      }),
                      trustedContactService.broadcastEmergency({
                        rideId: ride.id,
                        latitude: lat,
                        longitude: lng,
                        driverName: ride.driver_name ?? null,
                        vehiclePlate: ride.vehicle_plate ?? null,
                        riderName: null,
                      }).then((res) => {
                        if (res.contacts_notified > 0) {
                          // Surface confirmation via lightweight toast.
                          if (typeof window !== 'undefined') {
                            const toast = document.createElement('div');
                            toast.textContent = t('track.sos_contacts_notified', {
                              count: res.contacts_notified,
                              defaultValue: `${res.contacts_notified} contactos avisados por SMS`,
                            });
                            Object.assign(toast.style, {
                              position: 'fixed', bottom: '5rem', left: '50%', transform: 'translateX(-50%)',
                              background: '#16a34a', color: 'white', padding: '0.75rem 1.5rem',
                              borderRadius: '0.75rem', fontSize: '0.875rem', fontWeight: '600',
                              zIndex: '9999', boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                            });
                            document.body.appendChild(toast);
                            setTimeout(() => toast.remove(), 4000);
                          }
                        }
                      }),
                    ]).catch(() => { /* best-effort, swallow errors */ });
                    // Open dialer last (always succeeds — even when
                    // offline the dialer launches, user just sees no
                    // signal indicator). Cuban emergency line is 106.
                    window.location.href = 'tel:106';
                  }}
                  aria-label={t('track.sos_button_aria', { defaultValue: 'SOS — llamar a emergencias y avisar contactos' })}
                >
                  🚨 {t('track.sos_button', { defaultValue: 'SOS' })}
                </button>
              )}
            </div>
          )}

          {/* Live Indicator */}
          {!isTerminal && (
            <div className="track-live">
              <span className="track-live-dot" />
              {t('track.live_updates', { defaultValue: 'Actualizando en tiempo real' })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
