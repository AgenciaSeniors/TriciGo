'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, rideService } from '@tricigo/api';
import type { SharedRideView, RideStatus } from '@tricigo/types';
import '../../[id]/track.css';

const TrackingMap = dynamic(() => import('../../TrackingMap'), { ssr: false });

/* ── SVG Icons ── */
const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
);
const IconX = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
);
const IconStar = ({ filled }: { filled: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill={filled ? '#F59E0B' : 'none'} stroke={filled ? '#F59E0B' : '#d1d5db'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
);
const IconClock = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
);
const IconShare = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
);
const IconWhatsApp = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" /></svg>
);

/* ── Status Steps ── */
function useStatusSteps() {
  const { t } = useTranslation('web');
  return useMemo(() => [
    { key: 'searching' as RideStatus, label: t('track.step_searching', { defaultValue: 'Buscando conductor' }), stepNumber: 1 },
    { key: 'accepted' as RideStatus, label: t('track.step_accepted', { defaultValue: 'Conductor asignado' }), stepNumber: 2 },
    { key: 'driver_en_route' as RideStatus, label: t('track.step_en_route', { defaultValue: 'En camino a recogerte' }), stepNumber: 3 },
    { key: 'arrived_at_pickup' as RideStatus, label: t('track.step_arrived', { defaultValue: 'Llegó al punto' }), stepNumber: 4 },
    { key: 'in_progress' as RideStatus, label: t('track.step_in_progress', { defaultValue: 'Viaje en curso' }), stepNumber: 5 },
    { key: 'arrived_at_destination' as RideStatus, label: t('track.step_at_destination', { defaultValue: 'En destino' }), stepNumber: 6 },
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
export default function SharedTrackingPage() {
  const { t } = useTranslation('web');
  const params = useParams();
  const token = params.token as string;
  const [ride, setRide] = useState<SharedRideView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [driverLocation, setDriverLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const statusSteps = useStatusSteps();

  const fetchRide = useCallback(async () => {
    try {
      const data = await rideService.getPublicRideByShareToken(token);
      if (data) setRide(data);
      else setError(t('track.invalid_link', { defaultValue: 'Enlace de seguimiento inválido o expirado' }));
    } catch {
      setError(t('track.error_loading', { defaultValue: 'Error al cargar el viaje' }));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  // Initial fetch only — no polling (real-time subscription handles updates)
  useEffect(() => {
    fetchRide();
  }, [fetchRide]);

  useEffect(() => {
    if (!ride) return;
    const channel = rideService.subscribeToRide(ride.id, (updated) => {
      setRide((prev) => {
        if (!prev) return null;
        // Only update fields that exist on SharedRideView
        const safe: Partial<SharedRideView> = {};
        if (updated.status) safe.status = updated.status as SharedRideView['status'];
        if (updated.accepted_at !== undefined) safe.accepted_at = updated.accepted_at;
        if (updated.pickup_at !== undefined) safe.pickup_at = updated.pickup_at;
        if (updated.arrived_at_destination_at !== undefined) safe.arrived_at_destination_at = updated.arrived_at_destination_at;
        if (updated.completed_at !== undefined) safe.completed_at = updated.completed_at;
        if (updated.canceled_at !== undefined) safe.canceled_at = updated.canceled_at;
        return { ...prev, ...safe };
      });
    });
    return () => { channel.unsubscribe(); };
  }, [ride?.id]);

  // Subscribe to driver location via ride-level channel (no driver_id exposed)
  useEffect(() => {
    if (!ride) return;
    const isActive = !['completed', 'canceled', 'disputed'].includes(ride.status);
    if (!isActive) return;
    const supabase = getSupabaseClient();
    const channel = supabase.channel(`ride-driver-location-${ride.id}`)
      .on('broadcast', { event: 'driver_location' }, (payload: { payload: { latitude: number; longitude: number } }) => {
        setDriverLocation({ lat: payload.payload.latitude, lng: payload.payload.longitude });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [ride?.id, ride?.status]);

  /* ── Loading State ── */
  if (loading) {
    return (
      <div className="track-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 40, height: 40, border: '3px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.6s linear infinite', margin: '0 auto 16px' }} />
          <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>{t('track.loading', { defaultValue: 'Cargando viaje...' })}</p>
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
        <Link href="/" className="track-back-link">{t('track.back_home', { defaultValue: 'Ir a TriciGo' })}</Link>
      </div>
    );
  }

  const currentStepIdx = statusSteps.findIndex((s) => s.key === ride.status);
  const isCanceled = ride.status === 'canceled';
  const isCompleted = ride.status === 'completed';
  const isTerminal = isCanceled || isCompleted || ride.status === 'disputed';

  const pickupLat = ride.pickup_location?.latitude ?? 0;
  const pickupLng = ride.pickup_location?.longitude ?? 0;
  const dropoffLat = ride.dropoff_location?.latitude ?? 0;
  const dropoffLng = ride.dropoff_location?.longitude ?? 0;

  const statusBadgeClass = isCanceled ? 'track-status-badge--canceled'
    : ride.status === 'completed' ? 'track-status-badge--completed'
    : ride.status === 'searching' ? 'track-status-badge--searching'
    : 'track-status-badge--active';

  const statusLabel = isCanceled ? t('track.canceled', { defaultValue: 'Cancelado' })
    : ride.status === 'completed' ? t('track.step_completed', { defaultValue: 'Completado' })
    : ride.status === 'arrived_at_destination' ? t('track.step_at_destination', { defaultValue: 'En destino' })
    : ride.status === 'searching' ? t('track.step_searching', { defaultValue: 'Buscando' })
    : t('track.step_in_progress', { defaultValue: 'En curso' });

  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';

  const handleShare = async () => {
    if (navigator.share) {
      await navigator.share({ title: 'TriciGo — Seguimiento', url: shareUrl });
    } else {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    }
  };

  return (
    <div className="track-page track-page--shared">
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
            style={{ width: '100%', height: '100%', borderRadius: 0 }}
          />

          {/* ETA Badge */}
          {!isTerminal && ride.estimated_duration_s > 0 && (
            <div className="track-eta-badge">
              <IconClock />
              <span>~{Math.ceil(ride.estimated_duration_s / 60)} min</span>
            </div>
          )}
        </div>

        {/* ═══ RIGHT: Info Panel ═══ */}
        <div className="track-panel">
          {/* Shared branding */}
          <div style={{ textAlign: 'center', paddingBottom: 4 }}>
            <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 800, margin: 0 }}>
              Trici<span style={{ color: 'var(--primary)' }}>Go</span>
            </h2>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              {t('track.shared_tracking', { defaultValue: 'Seguimiento compartido' })}
            </span>
          </div>

          <div className="track-panel-header">
            <div>
              <h1 className="track-panel-title">
                {t('track.title', { defaultValue: 'Seguimiento de viaje' })}
              </h1>
              <span className="track-panel-id">ID: {ride.id.slice(0, 8)}</span>
            </div>
            <span className={`track-status-badge ${statusBadgeClass}`}>{statusLabel}</span>
          </div>

          {/* Status Stepper or Canceled */}
          {isCanceled ? (
            <div className="track-canceled-card track-card">
              <div className="track-canceled-icon"><IconX /></div>
              <div className="track-canceled-title">{t('track.canceled', { defaultValue: 'Viaje cancelado' })}</div>
            </div>
          ) : (
            <div className="track-card">
              <StatusStepper steps={statusSteps} currentIdx={currentStepIdx} />
            </div>
          )}

          {/* Route Card — coordinates only for privacy */}
          <div className="track-card">
            <div className="track-route">
              <div className="track-route-dots">
                <div className="track-route-dot track-route-dot--pickup" />
                <div className="track-route-line" />
                <div className="track-route-dot track-route-dot--dropoff" />
              </div>
              <div className="track-route-addresses">
                <div>
                  <div className="track-route-label">{t('track.from', { defaultValue: 'Origen' })}</div>
                  <div className="track-route-address" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                    {pickupLat.toFixed(4)}, {pickupLng.toFixed(4)}
                  </div>
                </div>
                <div>
                  <div className="track-route-label">{t('track.to', { defaultValue: 'Destino' })}</div>
                  <div className="track-route-address" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                    {dropoffLat.toFixed(4)}, {dropoffLng.toFixed(4)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Driver Card — first name only for privacy */}
          {ride.driver_first_name && (
            <div className="track-card">
              <div className="track-route-label" style={{ marginBottom: 10 }}>{t('track.your_driver', { defaultValue: 'Tu conductor' })}</div>
              <div className="track-driver">
                <div className="track-driver-avatar">
                  {ride.driver_first_name.charAt(0).toUpperCase()}
                </div>
                <div className="track-driver-info">
                  <div className="track-driver-name">{ride.driver_first_name}</div>
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
            </div>
          )}

          {/* ETA Card — estimated duration (no fare for privacy) */}
          {!isTerminal && ride.estimated_duration_s > 0 && (
            <div className="track-card">
              <div className="track-fare">
                <span className="track-fare-label">
                  {t('track.estimated_time', { defaultValue: 'Tiempo estimado' })}
                </span>
                <span className="track-fare-amount">
                  ~{Math.ceil(ride.estimated_duration_s / 60)} min
                </span>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="track-actions">
            <button className="track-action-btn track-action-btn--share" onClick={handleShare}>
              <IconShare />
              {shareCopied ? t('track.copied', { defaultValue: 'Copiado' }) : t('track.share_link', { defaultValue: 'Copiar enlace' })}
            </button>
            <a
              className="track-action-btn track-action-btn--whatsapp"
              href={`https://wa.me/?text=${encodeURIComponent(`Sigue mi viaje en TriciGo: ${shareUrl}`)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <IconWhatsApp />
              WhatsApp
            </a>
          </div>

          {/* Live indicator */}
          {!isTerminal && (
            <div className="track-live">
              <div className="track-live-dot" />
              {t('track.live_updates', { defaultValue: 'Actualización en tiempo real' })}
            </div>
          )}

          {/* Powered-by footer */}
          <div className="track-powered-by">
            <span>Powered by</span>
            <span className="track-powered-logo">Trici<span>Go</span></span>
          </div>
        </div>
      </div>
    </div>
  );
}
