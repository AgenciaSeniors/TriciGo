'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, rideService } from '@tricigo/api';
import { formatCUP } from '@tricigo/utils';
import type { RideWithDriver, RideStatus } from '@tricigo/types';

const TrackingMap = dynamic(() => import('../TrackingMap'), { ssr: false });

function useStatusSteps() {
  const { t } = useTranslation('web');
  return useMemo(() => [
    { key: 'searching' as RideStatus, label: t('track.step_searching'), stepNumber: 1 },
    { key: 'accepted' as RideStatus, label: t('track.step_accepted'), stepNumber: 2 },
    { key: 'driver_en_route' as RideStatus, label: t('track.step_en_route'), stepNumber: 3 },
    { key: 'arrived_at_pickup' as RideStatus, label: t('track.step_arrived'), stepNumber: 4 },
    { key: 'in_progress' as RideStatus, label: t('track.step_in_progress'), stepNumber: 5 },
    { key: 'completed' as RideStatus, label: t('track.step_completed'), stepNumber: 6 },
  ], [t]);
}

export default function TrackRidePage() {
  const { t } = useTranslation('web');
  const params = useParams();
  const rideId = params.id as string;
  const [ride, setRide] = useState<RideWithDriver | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [driverLocation, setDriverLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const statusSteps = useStatusSteps();

  const fetchRide = useCallback(async () => {
    try {
      const data = await rideService.getRideWithDriver(rideId);
      if (data) setRide(data);
      else setError(t('track.not_found'));
    } catch {
      setError(t('track.error_loading'));
    } finally {
      setLoading(false);
    }
  }, [rideId, t]);

  useEffect(() => {
    fetchRide();

    // Subscribe to real-time updates
    const channel = rideService.subscribeToRide(rideId, (updated) => {
      setRide((prev) => (prev ? { ...prev, ...updated } : null));
    });

    // Fallback polling every 10s
    const interval = setInterval(fetchRide, 10_000);

    return () => {
      channel.unsubscribe();
      clearInterval(interval);
    };
  }, [rideId, fetchRide]);

  // Subscribe to driver location broadcasts
  useEffect(() => {
    if (!ride?.driver_id) return;
    const supabase = getSupabaseClient();
    const channel = supabase.channel(`driver-location-${ride.driver_id}`)
      .on('broadcast', { event: 'location' }, (payload: { payload: { latitude: number; longitude: number } }) => {
        setDriverLocation({ lat: payload.payload.latitude, lng: payload.payload.longitude });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [ride?.driver_id]);

  if (loading) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#888', fontSize: '1.125rem' }}>{t('track.loading')}</p>
      </main>
    );
  }

  if (error || !ride) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <p style={{ color: 'var(--primary-dark)', fontSize: '1.125rem', marginBottom: '1rem' }}>{error ?? t('track.not_found')}</p>
        <Link href="/" style={{ color: 'var(--primary)', textDecoration: 'none' }}>{t('track.back_home')}</Link>
      </main>
    );
  }

  const currentStepIdx = statusSteps.findIndex((s) => s.key === ride.status);
  const isCanceled = ride.status === 'canceled';
  const isDisputed = ride.status === 'disputed';
  const isTerminal = isCanceled || isDisputed || ride.status === 'completed';

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '2rem',
      }}
    >
      <div style={{ maxWidth: 500, width: '100%' }}>
        <Link
          href="/"
          style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}
        >
          {t('track.back_home')}
        </Link>

        <h1 style={{ fontSize: '1.75rem', fontWeight: 800, marginTop: '1rem', marginBottom: '0.25rem' }}>
          {t('track.title')}
        </h1>
        <p style={{ color: '#888', fontSize: '0.8rem', marginBottom: '1.5rem' }}>
          ID: {ride.id.slice(0, 8)}...
        </p>

        {/* Map */}
        <div style={{ marginBottom: '1.5rem' }}>
          <TrackingMap
            pickupLat={ride.pickup_location.latitude}
            pickupLng={ride.pickup_location.longitude}
            dropoffLat={ride.dropoff_location.latitude}
            dropoffLng={ride.dropoff_location.longitude}
            driverLat={driverLocation?.lat}
            driverLng={driverLocation?.lng}
          />
        </div>

        {/* Status stepper */}
        {isCanceled ? (
          <div style={{ padding: '1rem', background: '#FEE', borderRadius: '0.75rem', textAlign: 'center', marginBottom: '1.5rem' }}>
            <span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#EF4444' }}>✕</span>
            <p style={{ fontWeight: 700, marginTop: '0.5rem' }}>{t('track.canceled')}</p>
            {ride.cancellation_reason && (
              <p style={{ color: '#888', fontSize: '0.8rem', marginTop: '0.25rem' }}>{ride.cancellation_reason}</p>
            )}
          </div>
        ) : isDisputed ? (
          <div style={{ padding: '1rem', background: '#FFF3E0', borderRadius: '0.75rem', textAlign: 'center', marginBottom: '1.5rem' }}>
            <span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#F59E0B' }}>!</span>
            <p style={{ fontWeight: 700, marginTop: '0.5rem' }}>{t('track.disputed')}</p>
          </div>
        ) : (
          <div style={{ marginBottom: '1.5rem' }}>
            {statusSteps.map((step, idx) => {
              const isActive = idx === currentStepIdx;
              const isDone = idx < currentStepIdx;
              return (
                <div
                  key={step.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '0.6rem 0',
                    opacity: isDone || isActive ? 1 : 0.35,
                  }}
                >
                  <span
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: isActive ? 'var(--primary)' : isDone ? '#4CAF50' : '#eee',
                      color: isDone || isActive ? 'white' : '#aaa',
                      fontWeight: 700,
                      fontSize: '0.8rem',
                      flexShrink: 0,
                    }}
                  >
                    {isDone ? '✓' : step.stepNumber}
                  </span>
                  <span style={{ fontWeight: isActive ? 700 : 400, fontSize: '0.9rem' }}>
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Route info */}
        <div
          style={{
            padding: '1rem',
            borderRadius: '0.75rem',
            border: '1px solid #eee',
            marginBottom: '1rem',
          }}
        >
          <div style={{ marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#888', display: 'block' }}>{t('track.from')}</span>
            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{ride.pickup_address}</span>
          </div>
          <div>
            <span style={{ fontSize: '0.75rem', color: '#888', display: 'block' }}>{t('track.to')}</span>
            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{ride.dropoff_address}</span>
          </div>
        </div>

        {/* Fare info */}
        <div
          style={{
            padding: '1rem',
            borderRadius: '0.75rem',
            border: '1px solid #eee',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1rem',
          }}
        >
          <span style={{ color: '#666', fontSize: '0.875rem' }}>
            {isTerminal ? t('track.final_fare') : t('track.estimated_fare')}
          </span>
          <span style={{ fontWeight: 800, fontSize: '1.25rem', color: 'var(--primary)' }}>
            {formatCUP(ride.final_fare_cup ?? ride.estimated_fare_cup)}
          </span>
        </div>

        {/* Driver info */}
        {ride.driver_name && (
          <div
            style={{
              padding: '1rem',
              borderRadius: '0.75rem',
              border: '1px solid #eee',
              marginBottom: '1rem',
            }}
          >
            <span style={{ fontSize: '0.75rem', color: '#888', display: 'block', marginBottom: '0.5rem' }}>
              {t('track.your_driver')}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: '50%',
                  background: 'var(--primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'white',
                  fontWeight: 700,
                  fontSize: '1.25rem',
                  flexShrink: 0,
                }}
              >
                {ride.driver_name.charAt(0).toUpperCase()}
              </div>
              <div>
                <div style={{ fontWeight: 700 }}>{ride.driver_name}</div>
                {ride.vehicle_make && (
                  <div style={{ fontSize: '0.8rem', color: '#666' }}>
                    {ride.vehicle_color} {ride.vehicle_make} {ride.vehicle_model} · {ride.vehicle_plate}
                  </div>
                )}
                {ride.driver_rating && (
                  <div style={{ fontSize: '0.8rem', color: '#888' }}>
                    ⭐ {ride.driver_rating.toFixed(1)}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Share & Contact buttons */}
        {!isTerminal && (
          <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
            {ride.share_token && (
              <button
                onClick={() => {
                  const url = `https://tricigo.com/track/share/${ride.share_token}`;
                  navigator.clipboard.writeText(url).then(() => {
                    setShareCopied(true);
                    setTimeout(() => setShareCopied(false), 2000);
                  });
                }}
                style={{
                  flex: 1, padding: '0.75rem', borderRadius: '0.75rem',
                  border: '1px solid var(--border-light, #eee)', background: 'var(--bg-card, #fff)',
                  cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600,
                  color: 'var(--text-primary)', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', gap: '0.5rem',
                }}
              >
                {shareCopied ? '✓ Enlace copiado' : '🔗 Compartir viaje'}
              </button>
            )}
            {ride.driver_phone && (
              <a
                href={`https://wa.me/${ride.driver_phone.replace(/[^0-9]/g, '')}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  flex: 1, padding: '0.75rem', borderRadius: '0.75rem',
                  border: '1px solid #25D366', background: '#25D366',
                  color: 'white', textDecoration: 'none', fontSize: '0.85rem',
                  fontWeight: 600, textAlign: 'center', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                }}
              >
                💬 Contactar conductor
              </a>
            )}
          </div>
        )}

        {/* Live indicator */}
        {!isTerminal && (
          <p style={{ textAlign: 'center', fontSize: '0.75rem', color: '#888', marginTop: '1rem' }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#10B981', marginRight: 6 }} />{t('track.live_updates')}
          </p>
        )}
      </div>
    </main>
  );
}
