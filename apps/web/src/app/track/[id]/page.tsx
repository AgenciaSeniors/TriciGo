'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, rideService, deliveryService, reviewService, nearbyService, trustedContactService, incidentService, notificationService, useFeatureFlag } from '@tricigo/api';
import { formatCUP, generateReceiptHTML, haversineDistance } from '@tricigo/utils';
import type { RideWithDriver, RideStatus, Waypoint } from '@tricigo/types';
import { useDriverPosition } from '../../../hooks/useDriverPosition';
import { useRiderLocationSharing } from '../../../hooks/useRiderLocationSharing';
import { useSearchingRide } from '../../../hooks/useSearchingRide';
import { useSearchingDrivers } from '../../../hooks/useSearchingDrivers';
import { useUnreadChatCount } from '../../../hooks/useUnreadChatCount';
import { useTripProgress } from '../../../hooks/useTripProgress';
import { fetchRoute } from '../../../services/geoService';
import { TipFlow } from '../../../components/TipFlow';
import { AddressAutocomplete } from '../../../components/AddressAutocomplete';
import { FareSplitCard } from './FareSplitCard';
import { StopPickerMap } from './StopPickerMap';
import './track.css';

// Categorized rating tag keys — mirror the mobile RideCompleteView fallback
// set (apps/client/src/components/RideCompleteView.tsx). The tag chips are
// gated behind the `categorized_ratings_enabled` feature flag, exactly like
// the native client; when enabled, the selected keys are passed to
// reviewService.submitReview as `tags` (NOT folded into the comment text).
const FALLBACK_POSITIVE_TAGS = [
  'clean_vehicle', 'great_conversation', 'expert_navigation', 'smooth_driving', 'went_above_and_beyond',
];
const FALLBACK_NEGATIVE_TAGS = [
  'dirty_vehicle', 'unsafe_driving', 'rude_behavior', 'wrong_route', 'long_wait',
];
const RATING_TAG_LABELS_ES: Record<string, string> = {
  clean_vehicle: 'Vehículo limpio',
  great_conversation: 'Gran conversación',
  expert_navigation: 'Navegación experta',
  smooth_driving: 'Manejo suave',
  went_above_and_beyond: 'Fue más allá',
  dirty_vehicle: 'Vehículo sucio',
  unsafe_driving: 'Manejo inseguro',
  rude_behavior: 'Comportamiento grosero',
  wrong_route: 'Ruta incorrecta',
  long_wait: 'Espera larga',
};

// Inline "hace X" formatter (parity con formatTimeAgo de @tricigo/utils, que
// no está re-exportado del index del paquete). Usado por el banner "Visto hace X".
function formatTimeAgo(timestampMs: number): string {
  const diffMin = Math.floor((Date.now() - timestampMs) / 60000);
  if (diffMin < 1) return 'ahora';
  if (diffMin < 60) return `hace ${diffMin} min`;
  return `hace ${Math.floor(diffMin / 60)}h`;
}

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
const IconChat = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
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
const IconNavigate = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polygon points="16 8 10 14 8 16 14 10" /><polygon points="16 8 14 14 10 16 12 10" fill="currentColor" /></svg>
);
const IconPlus = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
);
const IconReceipt = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" /><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" /><path d="M12 17.5v-11" /></svg>
);
const IconMail = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></svg>
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
  const [sharing, setSharing] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [deliveryDetails, setDeliveryDetails] = useState<{
    recipient_name?: string; recipient_phone?: string; package_description?: string;
    package_category?: string; estimated_weight_kg?: number; client_accompanies?: boolean;
    pickup_photo_url?: string | null; delivery_photo_url?: string | null;
    delivery_otp?: string | null;
  } | null>(null);
  const statusSteps = useStatusSteps();

  // Driver position via polling RPC (BUG-277 — the broadcast channel is dead;
  // the GPS loop only writes via update_driver_position). Active only while a
  // driver is assigned and the ride is in flight.
  const driverActive = !!ride && ['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress'].includes(ride.status);
  const driverPos = useDriverPosition(ride?.driver_id, driverActive);
  const driverLocation = driverPos.position ? { lat: driverPos.position.latitude, lng: driverPos.position.longitude } : null;

  // Unread in-app chat badge (parity con useUnreadChatCount móvil) — polls while
  // a driver is assigned so the rider sees pending messages from the map view.
  const { count: unreadChatCount, markRead: markChatRead } = useUnreadChatCount(
    driverActive ? ride?.id : null,
    userId,
  );

  // Share the rider's location with the driver during the pickup phase so the
  // driver app shows the rider's pin (parity con useRiderLocationSharing móvil).
  useRiderLocationSharing(ride?.id, ride?.status, userId);

  // Persistent driver search: heartbeat + radius-expansion while searching
  // (parity con el loop de useRide.ts). Never auto-cancels.
  const { searchRound } = useSearchingRide(ride?.id, ride?.status === 'searching');

  // Presence of drivers reviewing the request + fast accept broadcast
  // (parity con useSearchingDrivers). Best-effort; polling stays authoritative.
  const { drivers: searchingDrivers } = useSearchingDrivers(
    ride?.id,
    ride?.status === 'searching',
    () => { fetchRide(); },
  );

  // Dynamic ETA (min) recomputed from the driver's live position toward the
  // current target (pickup before in_progress, dropoff during the trip).
  const [dynamicEtaMin, setDynamicEtaMin] = useState<number | null>(null);

  // Trip progress bar (parity con useTripProgress móvil): the pickup→dropoff
  // polyline + total distance, captured once the trip starts so the driver
  // can be projected onto it for a monotonic progress %.
  const [tripRoute, setTripRoute] = useState<{ coordinates: { latitude: number; longitude: number }[]; distanceM: number } | null>(null);

  // "Conductor no se mueve" detection (parity con el banner stuck de
  // RideActiveView): track when the driver's coordinates last changed.
  const [driverStuck, setDriverStuck] = useState(false);
  const lastMovePosRef = useRef<{ lat: number; lng: number } | null>(null);
  const lastMoveAtRef = useRef<number>(Date.now());

  // Nearby vehicles (shown during searching)
  const [nearbyVehicles, setNearbyVehicles] = useState<Array<{ latitude: number; longitude: number; heading?: number | null; vehicle_type?: string }>>([]);

  // Review form state
  const [rating, setRating] = useState(0);
  const [reviewComment, setReviewComment] = useState('');
  const [reviewTags, setReviewTags] = useState<string[]>([]);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);

  // Categorized rating tags — gated behind the same feature flag the mobile
  // client uses, so the web matches whatever the native rider shows.
  const categorizedRatingsEnabled = useFeatureFlag('categorized_ratings_enabled');
  const [positiveTags, setPositiveTags] = useState<string[]>(FALLBACK_POSITIVE_TAGS);
  const [negativeTags, setNegativeTags] = useState<string[]>(FALLBACK_NEGATIVE_TAGS);
  useEffect(() => {
    if (!categorizedRatingsEnabled) return;
    Promise.all([
      reviewService.getTagDefinitions('rider_to_driver', 'positive'),
      reviewService.getTagDefinitions('rider_to_driver', 'negative'),
    ]).then(([pos, neg]) => {
      if (pos.length > 0) setPositiveTags(pos.map((d) => d.key));
      if (neg.length > 0) setNegativeTags(neg.map((d) => d.key));
    }).catch(() => { /* use fallback keys */ });
  }, [categorizedRatingsEnabled]);

  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';

  // Add-stop mid-ride state (parity con RideActiveView). Waypoints come from
  // getRideWaypoints (RPC extracts lat/lng from the opaque GEOGRAPHY column).
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [addStopOpen, setAddStopOpen] = useState(false);
  const [showStopMap, setShowStopMap] = useState(false);
  const [estimatingStop, setEstimatingStop] = useState(false);
  const [addingStop, setAddingStop] = useState(false);
  const [pendingStop, setPendingStop] = useState<
    | { address: string; latitude: number; longitude: number; extraDistanceKm: number; extraFareCup: number; extraDurationMin: number }
    | null
  >(null);
  const [maxStopsReached, setMaxStopsReached] = useState(false);
  const [gpsCheckSaidNo, setGpsCheckSaidNo] = useState(false);

  // Completion extras state (parity con RideCompleteView).
  const [downloadingReceipt, setDownloadingReceipt] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [receiptEmailed, setReceiptEmailed] = useState(false);
  const [showRatingReminder, setShowRatingReminder] = useState(false);

  const handleSubmitReview = async () => {
    if (!rating || !ride?.driver_id || !userId) return;
    setReviewSubmitting(true);
    try {
      // Pass the selected categorized tag keys as the dedicated `tags` param
      // (parity con el mobile RideCompleteView — reviewService los inserta en
      // review_tags por tag_key, sin doblarlos en el comentario).
      await reviewService.submitReview({
        ride_id: rideId,
        reviewer_id: userId,
        reviewee_id: ride.driver_id,
        rating: rating as 1 | 2 | 3 | 4 | 5,
        comment: reviewComment.trim() || undefined,
        tags: categorizedRatingsEnabled && reviewTags.length > 0 ? reviewTags : undefined,
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

  const refetchWaypoints = useCallback(() => {
    rideService.getRideWaypoints(rideId).then(setWaypoints).catch(() => {});
  }, [rideId]);

  // Add-stop flow (parity con RideActiveView): pick address → estimate the
  // fare delta → confirm → addWaypointToActiveRide → refetch the list.
  // Extra time matches the server trigger (00341): urban 25 km/h.
  const extraMinFromKm = (km: number) => Math.max(0, Math.round((km / 25) * 60));

  const handleSelectStop = async (result: { address: string; latitude: number; longitude: number }) => {
    setMaxStopsReached(false);
    setEstimatingStop(true);
    try {
      const existing = waypoints.map((w) => ({ latitude: w.location.latitude, longitude: w.location.longitude }));
      const { extraDistanceKm, extraFareCup } = await rideService.estimateWaypointAddition(
        rideId, result.latitude, result.longitude, existing,
      );
      setPendingStop({ address: result.address, latitude: result.latitude, longitude: result.longitude, extraDistanceKm, extraFareCup, extraDurationMin: extraMinFromKm(extraDistanceKm) });
    } catch {
      // Fall back to adding without preview rather than blocking the feature.
      setPendingStop({ address: result.address, latitude: result.latitude, longitude: result.longitude, extraDistanceKm: 0, extraFareCup: 0, extraDurationMin: 0 });
    } finally {
      setEstimatingStop(false);
      setAddStopOpen(false);
      setShowStopMap(false);
    }
  };

  const confirmAddStop = async () => {
    if (!pendingStop) return;
    setAddingStop(true);
    try {
      await rideService.addWaypointToActiveRide(rideId, pendingStop.address, pendingStop.latitude, pendingStop.longitude);
      setPendingStop(null);
      refetchWaypoints();
      // The 00341 trigger recomputed rides.estimated_distance_m/duration_s/fare
      // + the estimate snapshot server-side — refetch the ride so the fare card,
      // ETA and progress reflect the stop ("make it part of the trip").
      fetchRide();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String((err as { message?: string } | null)?.message ?? '');
      if (msg === 'MAX_WAYPOINTS_REACHED') {
        setMaxStopsReached(true);
        setPendingStop(null);
      }
    } finally {
      setAddingStop(false);
    }
  };

  // Receipt download — fetch the receipt data, render the shared HTML5
  // template and open it in a new tab to print/save as PDF (parity con
  // handleDownloadReceipt en RideCompleteView, que usa Print + Share).
  const handleDownloadReceipt = async () => {
    if (downloadingReceipt) return;
    setDownloadingReceipt(true);
    // Open the tab synchronously inside the click gesture so popup blockers
    // don't kill it after the await.
    const win = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    try {
      const data = await rideService.getReceiptData(rideId, 'passenger');
      const html = generateReceiptHTML(data);
      if (win) {
        win.document.open();
        win.document.write(html);
        win.document.close();
        win.focus();
        setTimeout(() => { try { win.print(); } catch { /* user can print manually */ } }, 500);
      } else {
        // Popup blocked → fall back to a blob download.
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `recibo-tricigo-${rideId.slice(0, 8)}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch {
      if (win) win.close();
      alert(t('track.receipt_error', { defaultValue: 'No se pudo generar el recibo. Probá de nuevo en un momento.' }));
    } finally {
      setDownloadingReceipt(false);
    }
  };

  const handleEmailReceipt = async () => {
    if (!userId || sendingEmail) return;
    setSendingEmail(true);
    try {
      await notificationService.sendRideReceipt(rideId, userId);
      setReceiptEmailed(true);
    } catch {
      alert(t('track.receipt_email_failed', { defaultValue: 'No se pudo enviar el recibo' }));
    } finally {
      setSendingEmail(false);
    }
  };

  const ratingCardRef = useRef<HTMLDivElement>(null);

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

  // Capture the pickup→dropoff polyline once the trip starts so the progress
  // bar can project the driver onto a fixed path (monotonic %). Fetched a
  // single time per ride.
  useEffect(() => {
    if (!ride || ride.status !== 'in_progress' || tripRoute) return;
    const pLat = typeof ride.pickup_location === 'object' ? ride.pickup_location.latitude : 0;
    const pLng = typeof ride.pickup_location === 'object' ? ride.pickup_location.longitude : 0;
    const dLat = typeof ride.dropoff_location === 'object' ? ride.dropoff_location.latitude : 0;
    const dLng = typeof ride.dropoff_location === 'object' ? ride.dropoff_location.longitude : 0;
    if (!pLat || !pLng || !dLat || !dLng) return;
    let cancelled = false;
    fetchRoute({ lat: pLat, lng: pLng }, { lat: dLat, lng: dLng })
      .then((r) => {
        if (cancelled || !r) return;
        setTripRoute({
          coordinates: r.coordinates.map(([lat, lng]) => ({ latitude: lat, longitude: lng })),
          distanceM: r.distance_m,
        });
      })
      .catch(() => { /* progress bar falls back to inactive */ });
    return () => { cancelled = true; };
  }, [ride, tripRoute]);

  const tripProgress = useTripProgress({
    driverLocation: driverPos.position
      ? { latitude: driverPos.position.latitude, longitude: driverPos.position.longitude }
      : null,
    routeCoordinates: tripRoute?.coordinates ?? null,
    totalDistanceM: tripRoute?.distanceM ?? null,
    etaMinutes: dynamicEtaMin ?? (ride && ride.estimated_duration_s > 0 ? Math.ceil(ride.estimated_duration_s / 60) : null),
    rideStatus: ride?.status ?? null,
  });

  // Driver "stuck" detection — flips on when the driver's coordinates have
  // not changed (>20 m) for 5 minutes while still assigned (parity con el
  // banner "no se ha movido en 5 minutos" de RideActiveView).
  useEffect(() => {
    if (!driverActive || !driverPos.position) {
      lastMovePosRef.current = null;
      lastMoveAtRef.current = Date.now();
      setDriverStuck(false);
      return;
    }
    const { latitude, longitude } = driverPos.position;
    const prev = lastMovePosRef.current;
    const movedM = prev
      ? haversineDistance({ latitude: prev.lat, longitude: prev.lng }, { latitude, longitude })
      : Infinity;
    if (movedM > 20) {
      lastMovePosRef.current = { lat: latitude, lng: longitude };
      lastMoveAtRef.current = Date.now();
      setDriverStuck(false);
    }
  }, [driverActive, driverPos.position]);
  useEffect(() => {
    if (!driverActive) { setDriverStuck(false); return; }
    const id = setInterval(() => {
      setDriverStuck(lastMovePosRef.current != null && Date.now() - lastMoveAtRef.current > 5 * 60_000);
    }, 15_000);
    return () => clearInterval(id);
  }, [driverActive]);

  // Fetch waypoints while the ride is active (parity con RideActiveView).
  // Re-runs on each status change; confirmAddStop also refetches immediately.
  useEffect(() => {
    if (!ride) return;
    const active = ['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination'].includes(ride.status);
    if (!active) { setWaypoints([]); return; }
    refetchWaypoints();
  }, [ride?.id, ride?.status, refetchWaypoints]);

  // "Llegó seguro": al detectar la transición a completed, avisar UNA sola vez
  // a los contactos de confianza con auto_share (parity con useRide.ts:962-975).
  // Guard por localStorage para no re-disparar en cada refetch del polling.
  useEffect(() => {
    if (!ride || ride.status !== 'completed' || !userId || typeof window === 'undefined') return;
    const key = `tricigo_arrived_notified_${rideId}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    (async () => {
      try {
        const contacts = await trustedContactService.getAutoShareContacts(userId);
        if (contacts.length === 0) return;
        let name = 'Tu contacto';
        try {
          const { data: profile } = await getSupabaseClient().from('users').select('full_name').eq('id', userId).maybeSingle();
          if (profile?.full_name) name = profile.full_name as string;
        } catch { /* keep fallback */ }
        await notificationService.notifyTrustedContacts({
          contacts: contacts.map((c) => ({ name: c.name, phone: c.phone })),
          message: `✅ ${name} llegó a su destino de forma segura.`,
          eventType: 'trip_completed_safe',
        });
      } catch { /* best-effort, swallow errors */ }
    })();
  }, [ride?.status, rideId, userId]);

  // Recordatorio de calificación (versión liviana — el form ya está visible):
  // si sigue sin calificar 5 min después de completar, mostramos un banner que
  // hace scroll al rating. Sin notificación local (no aplica en web).
  useEffect(() => {
    if (!ride || ride.status !== 'completed' || reviewSubmitted || !ride.driver_id) {
      setShowRatingReminder(false);
      return;
    }
    const timer = setTimeout(() => setShowRatingReminder(true), 5 * 60_000);
    return () => clearTimeout(timer);
  }, [ride?.status, reviewSubmitted, ride?.driver_id]);

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

  // Proximity feedback (parity con ProximityBanner del client): cuando el
  // conductor entra en ~300m del punto activo, avisamos al pasajero.
  const PROXIMITY_THRESHOLD_M = 300;
  const showArrivingPickup = !!driverLocation
    && ['accepted', 'driver_en_route'].includes(ride.status)
    && haversineDistance({ latitude: driverLocation.lat, longitude: driverLocation.lng }, { latitude: pickupLat, longitude: pickupLng }) < PROXIMITY_THRESHOLD_M;
  const showApproachingDropoff = !!driverLocation
    && ride.status === 'in_progress'
    && haversineDistance({ latitude: driverLocation.lat, longitude: driverLocation.lng }, { latitude: dropoffLat, longitude: dropoffLng }) < PROXIMITY_THRESHOLD_M;

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
                background: (searchingDrivers.length > 0 || nearbyVehicles.length > 0) ? '#00C853' : 'var(--primary, #FF4D00)',
                display: 'inline-block',
                animation: (searchingDrivers.length === 0 && nearbyVehicles.length === 0) ? 'searchPulse 1.5s ease-in-out infinite' : 'none',
              }} />
              {searchingDrivers.length > 0
                ? t('track.drivers_reviewing', { defaultValue: `${searchingDrivers.length} conductor${searchingDrivers.length > 1 ? 'es' : ''} revisando tu solicitud` })
                : searchRound > 0
                  ? t('track.search_expanding', { defaultValue: 'Ampliando la búsqueda…' })
                  : nearbyVehicles.length > 0
                    ? `${nearbyVehicles.length} conductor${nearbyVehicles.length > 1 ? 'es' : ''} cerca`
                    : 'Buscando conductores cercanos...'}
            </div>
          )}

          {/* Trip progress bar — floating at the bottom of the map, only
              during the trip (parity con TripProgressBar móvil; useTripProgress
              proyecta el GPS del conductor sobre la polyline → % monótono). */}
          {tripProgress.isActive && (
            <div style={{ position: 'absolute', bottom: 16, left: 16, right: 16, background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(8px)', borderRadius: 12, padding: '0.7rem 0.9rem', boxShadow: '0 4px 16px rgba(0,0,0,0.18)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#111' }}>
                  {tripProgress.progressPercent >= 100
                    ? t('track.progress_arrived', { defaultValue: 'Llegando al destino' })
                    : t('track.progress_en_route', { defaultValue: 'En camino al destino' })}
                </span>
                <span style={{ fontSize: '0.74rem', color: '#555' }}>
                  {tripProgress.distanceRemainingKm} km
                  {tripProgress.etaMinutes != null && tripProgress.etaMinutes > 0 ? ` · ~${tripProgress.etaMinutes} min` : ''}
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 999, background: 'rgba(0,0,0,0.1)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${tripProgress.progressPercent}%`, background: 'var(--primary, #FF4D00)', borderRadius: 999, transition: 'width 0.5s ease' }} />
              </div>
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

          {/* Proximity banner — el conductor entró en ~300m del punto activo
              (parity con ProximityBanner del client). */}
          {(showArrivingPickup || showApproachingDropoff) && (
            <div className="track-card" style={{ background: 'rgba(0,200,83,0.1)', border: '1px solid rgba(0,200,83,0.4)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: '1.2rem' }} aria-hidden="true">📍</span>
              <span style={{ flex: 1, fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                {showArrivingPickup
                  ? t('track.driver_arriving', { defaultValue: 'Tu conductor está llegando al punto de recogida' })
                  : t('track.approaching_dest', { defaultValue: 'Estás llegando a tu destino' })}
              </span>
            </div>
          )}

          {/* Driver GPS unavailable — rider consent (parity con RideActiveView) */}
          {ride.driver_gps_status === 'unavailable' && (
            <div className="track-card" style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.35)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ color: '#dc2626', flexShrink: 0 }}><IconAlert /></span>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                  {t('track.gps_unavailable_title', { defaultValue: 'El GPS de tu conductor no está disponible' })}
                </span>
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0 0 0.75rem' }}>
                {t('track.gps_unavailable_body', { defaultValue: 'No podremos mostrar su ubicación en vivo. ¿Continuar igual o cancelar sin cargo?' })}
              </p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="button" onClick={() => { rideService.riderRespondToGpsUnavailable(rideId, true).then(() => fetchRide()).catch(() => {}); }}
                  style={{ flex: 1, padding: '0.6rem', borderRadius: '0.6rem', border: '1px solid var(--border)', background: 'var(--bg-card)', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {t('track.gps_continue', { defaultValue: 'Continuar igual' })}
                </button>
                <button type="button" onClick={() => { rideService.riderRespondToGpsUnavailable(rideId, false).then(() => fetchRide()).catch(() => {}); }}
                  style={{ flex: 1, padding: '0.6rem', borderRadius: '0.6rem', border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700 }}>
                  {t('track.gps_cancel_free', { defaultValue: 'Cancelar sin cargo' })}
                </button>
              </div>
            </div>
          )}

          {/* Confirmar llegada del conductor — el conductor dice que llegó pero
              su GPS lo ubica lejos del punto; el pasajero confirma visualmente
              (parity con RideActiveView BUG-244). Complementa el card de GPS no
              disponible: este aplica cuando hay GPS pero está fuera de rango. */}
          {ride.gps_override_requested_at && !ride.gps_override_confirmed_at && ride.driver_gps_status !== 'unavailable' && (
            <div className="track-card" style={{ background: 'rgba(255,77,0,0.08)', border: '1px solid var(--primary, #FF4D00)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ color: 'var(--primary, #FF4D00)', flexShrink: 0 }}><IconNavigate /></span>
                <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: 700 }}>
                  {t('track.gps_check_title', { defaultValue: '¿Tu conductor está acá?' })}
                </span>
              </div>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: '0 0 0.75rem' }}>
                {t('track.gps_check_body', {
                  driverName: ride.driver_name ?? 'Tu conductor',
                  distance: ride.gps_check_distance_m ?? '?',
                  defaultValue: `${ride.driver_name ?? 'Tu conductor'} dice que llegó (${ride.gps_check_distance_m ?? '?'}m según su GPS). Confirmá si lo ves cerca.`,
                })}
              </p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="button" onClick={() => { rideService.riderConfirmDriverArrival(rideId).then(() => fetchRide()).catch(() => {}); }}
                  style={{ flex: 1, padding: '0.6rem', borderRadius: '0.6rem', border: 'none', background: 'var(--primary, #FF4D00)', color: '#fff', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700 }}>
                  {t('track.gps_check_yes', { defaultValue: 'Sí, lo veo' })}
                </button>
                <button type="button" onClick={() => setGpsCheckSaidNo(true)}
                  style={{ flex: 1, padding: '0.6rem', borderRadius: '0.6rem', border: '1px solid var(--border)', background: 'var(--bg-card)', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {t('track.gps_check_no', { defaultValue: 'No lo veo' })}
                </button>
              </div>
              {gpsCheckSaidNo && (
                <p style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', margin: '0.6rem 0 0', textAlign: 'center' }}>
                  {t('track.gps_check_dismissed', { defaultValue: 'Le pedimos que se acerque más.' })}
                </p>
              )}
            </div>
          )}

          {/* Tracking health banner — single banner, priority stuck > stale >
              waiting (parity con la versión colapsada de RideActiveView).
              Muestra "Visto hace X" cuando la señal está vieja o el conductor
              no se mueve. */}
          {driverActive && (driverStuck || driverPos.isStale || !driverPos.position) && (
            <div className="track-card" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ color: '#f59e0b', flexShrink: 0 }}><IconAlert /></span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                  {driverStuck
                    ? t('track.driver_not_moving', { defaultValue: 'Tu conductor no se ha movido en 5 minutos.' })
                    : !driverPos.position
                      ? t('track.waiting_driver_location', { defaultValue: 'Esperando la ubicación del conductor...' })
                      : t('track.signal_stale', { defaultValue: 'La señal del conductor está intermitente. Mostrando su última ubicación conocida.' })}
                </span>
                {driverPos.position && (driverStuck || driverPos.isStale) && (
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>
                    {t('track.last_seen', { time: formatTimeAgo(driverPos.position.recordedAt), defaultValue: 'Visto {{time}}' })}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Dividir tarifa — gestión del solicitante en un viaje tricicoin
              activo (parity con FareSplitSheet). Sólo para el dueño del viaje. */}
          {!isTerminal && ride.payment_method === 'tricicoin' && userId === ride.customer_id && (
            <FareSplitCard rideId={ride.id} userId={userId} estimatedFareTrc={ride.estimated_fare_trc ?? 0} />
          )}

          {/* Recordatorio de calificación — aparece 5 min después de completar
              si el viaje sigue sin calificar (parity liviano con el rating
              reminder de useRide.ts, sin la notificación local). */}
          {showRatingReminder && !reviewSubmitted && ride.status === 'completed' && ride.driver_id && (
            <div className="track-card" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.4)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: '1.2rem' }} aria-hidden="true">⭐</span>
              <span style={{ flex: 1, fontSize: '0.84rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                {t('track.rating_reminder', { defaultValue: 'No olvides calificar tu viaje' })}
              </span>
              <button
                type="button"
                onClick={() => { ratingCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); setShowRatingReminder(false); }}
                style={{ padding: '0.4rem 0.8rem', borderRadius: '0.5rem', border: 'none', background: '#f59e0b', color: '#fff', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700 }}
              >
                {t('track.rate_now', { defaultValue: 'Calificar' })}
              </button>
            </div>
          )}

          {/* Ride Completion + Rating */}
          {ride.status === 'completed' && !reviewSubmitted && ride.driver_id && (
            <div ref={ratingCardRef} className="track-card" style={{ textAlign: 'center' }}>
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
                  {/* Categorized rating tags by tag_key — gated behind the
                      same `categorized_ratings_enabled` feature flag as the
                      mobile RideCompleteView. Selected keys go to submitReview
                      as `tags` (review_tags rows), not folded into the comment. */}
                  {categorizedRatingsEnabled && (
                    <div style={{ marginBottom: '0.75rem' }}>
                      <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textAlign: 'center', margin: '0 0 0.5rem' }}>
                        {t('track.rating_tags_title', { defaultValue: '¿Qué destacó?' })}
                      </p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', justifyContent: 'center' }}>
                        {(rating >= 4 ? positiveTags : negativeTags).slice(0, 3).map((key) => {
                          const on = reviewTags.includes(key);
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() => setReviewTags((prev) => prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key])}
                              style={{
                                padding: '0.35rem 0.7rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
                                border: on ? '2px solid var(--primary)' : '1px solid var(--border)',
                                background: on ? 'rgba(255,77,0,0.08)' : 'var(--bg-card)',
                                color: on ? 'var(--primary)' : 'var(--text-secondary)',
                              }}
                            >
                              {t(`track.tag_${key}`, { defaultValue: RATING_TAG_LABELS_ES[key] ?? key })}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
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
            <TipFlow rideId={ride.id} userId={userId} fareCup={ride.final_fare_cup ?? ride.estimated_fare_cup ?? 0} onTipSubmitted={fetchRide} />
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

          {/* Paradas intermedias + agregar parada (parity con RideActiveView).
              La lista se muestra si hay paradas; el botón "Agregar parada" solo
              durante in_progress (como el cliente), máx 3. */}
          {(waypoints.length > 0 || ride.status === 'in_progress') && !isTerminal && (
            <div className="track-card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: waypoints.length > 0 ? 10 : 0 }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {t('track.stops', { defaultValue: 'Paradas' })}
                </span>
                {waypoints.length > 0 && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{waypoints.length}/3</span>
                )}
              </div>

              {waypoints.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: ride.status === 'in_progress' && waypoints.length < 3 ? 12 : 0 }}>
                  {[...waypoints].sort((a, b) => a.sort_order - b.sort_order).map((wp, idx) => {
                    const done = !!wp.departed_at;
                    const current = !!wp.arrived_at && !wp.departed_at;
                    return (
                      <div key={wp.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, background: done ? '#00C853' : current ? 'var(--primary, #FF4D00)' : 'var(--bg-light)', color: (done || current) ? '#fff' : 'var(--text-tertiary)', border: (done || current) ? 'none' : '1px solid var(--border)' }}>
                          {done ? <IconCheck /> : idx + 1}
                        </span>
                        <span style={{ flex: 1, fontSize: '0.82rem', color: done ? 'var(--text-tertiary)' : 'var(--text-primary)', textDecoration: done ? 'line-through' : 'none' }}>
                          {wp.address}
                        </span>
                        {current && (
                          <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--primary, #FF4D00)' }}>{t('track.stop_current', { defaultValue: 'Actual' })}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {ride.status === 'in_progress' && waypoints.length < 3 && (
                !addStopOpen ? (
                  <button
                    type="button"
                    onClick={() => { setAddStopOpen(true); setMaxStopsReached(false); }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '0.6rem', borderRadius: '0.6rem', border: '1px dashed var(--border)', background: 'transparent', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, color: 'var(--primary, #FF4D00)' }}
                  >
                    <IconPlus /> {t('track.add_stop', { defaultValue: 'Agregar parada' })}
                  </button>
                ) : (
                  <div>
                    <AddressAutocomplete
                      placeholder={t('track.search_address', { defaultValue: 'Buscar dirección...' })}
                      mapboxToken={mapboxToken}
                      proximity={{ latitude: pickupLat, longitude: pickupLng }}
                      onSelect={handleSelectStop}
                    />
                    {/* Alternativa: marcar la parada en el mapa (parity con el
                        map-picker del add-stop móvil). */}
                    <button
                      type="button"
                      onClick={() => setShowStopMap(true)}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8, padding: '0.55rem', borderRadius: '0.5rem', border: '1px solid var(--border)', background: 'var(--bg-card)', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}
                    >
                      📍 {t('track.pick_on_map', { defaultValue: 'Marcar en el mapa' })}
                    </button>
                    {estimatingStop && (
                      <p style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', margin: '0.5rem 0 0', textAlign: 'center' }}>
                        {t('track.estimating_stop', { defaultValue: 'Calculando costo adicional...' })}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => setAddStopOpen(false)}
                      style={{ width: '100%', marginTop: 8, padding: '0.5rem', borderRadius: '0.5rem', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--text-tertiary)' }}
                    >
                      {t('common.cancel', { defaultValue: 'Cancelar' })}
                    </button>
                  </div>
                )
              )}

              {maxStopsReached && (
                <p style={{ fontSize: '0.78rem', color: '#dc2626', margin: '0.5rem 0 0', textAlign: 'center' }}>
                  {t('track.max_stops', { defaultValue: 'Máximo de paradas alcanzado' })}
                </p>
              )}
            </div>
          )}

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
              {/* Delivery OTP — visible while the cargo ride is active so the
                  rider can hand the 4-digit code to the recipient (the driver
                  asks for it at drop-off). Parity with mobile ride/[id]. */}
              {!isTerminal && deliveryDetails.delivery_otp && (
                <button
                  type="button"
                  onClick={() => { try { navigator.clipboard?.writeText(deliveryDetails.delivery_otp || ''); } catch { /* clipboard unavailable */ } }}
                  title="Toca para copiar"
                  style={{
                    width: '100%', margin: '0 0 12px', padding: '12px',
                    background: 'rgba(255,77,0,0.06)', border: '1px solid var(--primary)',
                    borderRadius: 'var(--radius-md)', cursor: 'pointer',
                  }}
                >
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 2 }}>
                    Codigo para el destinatario
                  </div>
                  <div style={{ fontSize: '1.7rem', fontWeight: 800, letterSpacing: 8, color: 'var(--primary)' }}>
                    {deliveryDetails.delivery_otp}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
                    El conductor lo pedira al entregar · toca para copiar
                  </div>
                </button>
              )}
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
            {/* Descuento aplicado (promo y/o compartir viaje) — parity con
                RideCompleteView ("Descuento aplicado: -$X"). */}
            {(ride.discount_amount_cup ?? 0) > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                <span style={{ fontSize: '0.82rem', color: '#16a34a', fontWeight: 600 }}>
                  {t('track.discount_applied', { defaultValue: 'Descuento aplicado' })}
                </span>
                <span style={{ fontSize: '0.85rem', color: '#16a34a', fontWeight: 700 }}>
                  -{formatCUP(ride.discount_amount_cup)}
                </span>
              </div>
            )}
            {/* Distancia · tiempo del viaje completado (parity con RideCompleteView).
                Mismo clamp defensivo BUG-291: cap a estimado×1.3 (o 100km) para que
                una muestra GPS corrupta nunca muestre "24.000 km". */}
            {ride.status === 'completed' && ride.actual_distance_m != null && (() => {
              const HARD_CEILING_M = 100_000;
              const estM = ride.estimated_distance_m ?? 0;
              const capM = estM > 0 ? Math.min(estM * 1.3, HARD_CEILING_M) : HARD_CEILING_M;
              const km = (Math.min(ride.actual_distance_m, capM) / 1000).toFixed(1);
              const mins = Math.round((ride.actual_duration_s ?? 0) / 60);
              return (
                <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                  <span>{km} km</span>
                  <span>{mins} min</span>
                </div>
              );
            })()}
          </div>

          {/* Recibo — descargar (HTML imprimible → PDF) o enviar por email.
              Solo en viajes completados (parity con RideCompleteView). */}
          {ride.status === 'completed' && (
            <div className="track-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ color: 'var(--text-secondary)' }}><IconReceipt /></span>
                <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {t('track.receipt_title', { defaultValue: 'Recibo del viaje' })}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={handleDownloadReceipt}
                  disabled={downloadingReceipt}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '0.65rem', borderRadius: '0.6rem', border: '1px solid var(--border)', background: 'var(--bg-card)', cursor: downloadingReceipt ? 'not-allowed' : 'pointer', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', opacity: downloadingReceipt ? 0.6 : 1 }}
                >
                  <IconReceipt /> {downloadingReceipt ? t('track.receipt_generating', { defaultValue: 'Generando...' }) : t('track.receipt_download', { defaultValue: 'Descargar recibo' })}
                </button>
                <button
                  type="button"
                  onClick={handleEmailReceipt}
                  disabled={sendingEmail || receiptEmailed}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '0.65rem', borderRadius: '0.6rem', border: '1px solid var(--border)', background: receiptEmailed ? 'rgba(0,200,83,0.1)' : 'var(--bg-card)', cursor: (sendingEmail || receiptEmailed) ? 'default' : 'pointer', fontSize: '0.82rem', fontWeight: 600, color: receiptEmailed ? '#00C853' : 'var(--text-primary)', opacity: sendingEmail ? 0.6 : 1 }}
                >
                  {receiptEmailed
                    ? <><IconCheck /> {t('track.receipt_emailed', { defaultValue: 'Enviado' })}</>
                    : <><IconMail /> {sendingEmail ? t('track.receipt_sending', { defaultValue: 'Enviando...' }) : t('track.receipt_email', { defaultValue: 'Enviar por email' })}</>}
                </button>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          {!isTerminal && (
            <div className="track-actions">
              {/* Compartir viaje: si aún no hay token, lo generamos al vuelo
                  (parity con handleShareTrip del client, que auto-genera el
                  token cuando falta) y luego copiamos el enlace. */}
              <button
                className="track-action-btn track-action-btn--share"
                disabled={sharing}
                onClick={async () => {
                  let token = ride.share_token;
                  if (!token) {
                    setSharing(true);
                    try {
                      token = await rideService.generateShareToken(rideId);
                      fetchRide();
                    } catch {
                      setSharing(false);
                      return;
                    }
                    setSharing(false);
                  }
                  const url = `https://tricigo.com/track/share/${token}`;
                  navigator.clipboard.writeText(url).then(() => {
                    setShareCopied(true);
                    setTimeout(() => setShareCopied(false), 2000);
                  });
                }}
              >
                {shareCopied ? <><IconCheck /> Enlace copiado</> : <><IconShare /> {sharing ? 'Generando…' : 'Compartir viaje'}</>}
              </button>
              {/* In-app chat (parity con el botón de chat de RideActiveView):
                  abre /chat/[id] con badge de no-leídos. Antes la web no tenía
                  punto de entrada al chat — sólo el WhatsApp externo. */}
              {driverActive && (
                <Link
                  href={`/chat/${ride.id}`}
                  className="track-action-btn"
                  onClick={() => markChatRead()}
                  style={{ position: 'relative', textDecoration: 'none', border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
                >
                  <IconChat /> {t('track.chat', { defaultValue: 'Mensajes' })}
                  {unreadChatCount > 0 && (
                    <span style={{ position: 'absolute', top: 4, right: 8, minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, background: '#dc2626', color: '#fff', fontSize: '0.7rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>
                      {unreadChatCount > 9 ? '9+' : unreadChatCount}
                    </span>
                  )}
                </Link>
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
                    if (!userId) return;
                    // Cancelling no longer charges money — a late cancel lowers
                    // the rider's visible rating instead. Preview that impact
                    // before confirming (parity with the mobile cancel sheet).
                    let confirmMsg = t('track.cancel_confirm_free', { defaultValue: '¿Seguro que quieres cancelar este viaje? No afecta tu calificación.' });
                    try {
                      const impact = await rideService.previewCancellationImpact(rideId);
                      if (impact?.rating_penalized) {
                        confirmMsg = typeof impact.stars_after === 'number'
                          ? t('track.cancel_confirm_rating', { defaultValue: `Cancelar ahora baja tu calificación a ★${impact.stars_after.toFixed(1)}. ¿Continuar?` })
                          : t('track.cancel_confirm_rating_generic', { defaultValue: 'Cancelar ahora baja tu calificación. ¿Continuar?' });
                      }
                    } catch {
                      confirmMsg = t('track.cancel_confirm', { defaultValue: '¿Seguro que quieres cancelar este viaje?' });
                    }
                    if (!confirm(confirmMsg)) return;
                    setCanceling(true);
                    try {
                      await rideService.cancelRide(rideId, userId ?? undefined, 'rider_canceled');
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
                        // against_user_id FK -> users(id); ride.driver_id is the
                        // driver_profiles.id -> use driver_user_id (the FK violation
                        // was failing the whole SOS insert).
                        against_user_id: ride.driver_user_id ?? undefined,
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

      {/* Confirmar parada — preview del delta de tarifa antes de agregar
          (parity con el BottomSheet de RideActiveView). */}
      {pendingStop && (
        <div
          onClick={() => { if (!addingStop) setPendingStop(null); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-card, #fff)', borderRadius: 16, padding: 20, maxWidth: 380, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,0.25)' }}>
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: '0 0 6px', color: 'var(--text-primary)' }}>
              {t('track.confirm_stop_title', { defaultValue: '¿Agregar esta parada?' })}
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0 0 14px', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              {pendingStop.address}
            </p>
            <div style={{ background: 'var(--bg-light)', borderRadius: 12, padding: 14, marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('track.extra_distance', { defaultValue: 'Distancia adicional' })}</span>
                <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>+{pendingStop.extraDistanceKm.toFixed(1)} km</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('track.extra_time', { defaultValue: 'Tiempo adicional' })}</span>
                <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>+{pendingStop.extraDurationMin} min</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('track.extra_fare', { defaultValue: 'Tarifa adicional estimada' })}</span>
                <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--primary, #FF4D00)' }}>+{formatCUP(pendingStop.extraFareCup)}</span>
              </div>
            </div>
            <p style={{ fontSize: '0.76rem', color: 'var(--text-tertiary)', margin: '0 0 14px', textAlign: 'center' }}>
              {t('track.confirm_stop_note', { defaultValue: 'Es una estimación. El total final se calcula según la ruta real.' })}
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                onClick={() => setPendingStop(null)}
                disabled={addingStop}
                style={{ flex: 1, padding: '0.7rem', borderRadius: '0.6rem', border: '1px solid var(--border)', background: 'var(--bg-card)', cursor: addingStop ? 'not-allowed' : 'pointer', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}
              >
                {t('common.cancel', { defaultValue: 'Cancelar' })}
              </button>
              <button
                type="button"
                onClick={confirmAddStop}
                disabled={addingStop}
                style={{ flex: 1, padding: '0.7rem', borderRadius: '0.6rem', border: 'none', background: 'var(--primary, #FF4D00)', color: '#fff', cursor: addingStop ? 'not-allowed' : 'pointer', fontSize: '0.85rem', fontWeight: 700, opacity: addingStop ? 0.7 : 1 }}
              >
                {addingStop ? t('track.adding_stop', { defaultValue: 'Agregando...' }) : t('track.confirm_add_stop', { defaultValue: 'Confirmar parada' })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Map picker for the add-stop flow (parity con el map-picker móvil). */}
      {showStopMap && (
        <StopPickerMap
          center={{ latitude: pickupLat, longitude: pickupLng }}
          onConfirm={handleSelectStop}
          onClose={() => setShowStopMap(false)}
        />
      )}
    </div>
  );
}
