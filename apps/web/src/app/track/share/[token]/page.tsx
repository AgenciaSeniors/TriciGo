'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, rideService } from '@tricigo/api';
import { formatCUP } from '@tricigo/utils';
import type { RideWithDriver, RideStatus } from '@tricigo/types';

const TrackingMap = dynamic(() => import('../../TrackingMap'), { ssr: false });

function useStatusSteps() {
  const { t } = useTranslation('web');
  return useMemo(() => [
    { key: 'searching' as RideStatus, label: t('track.step_searching'), step: 1 },
    { key: 'accepted' as RideStatus, label: t('track.step_accepted'), step: 2 },
    { key: 'driver_en_route' as RideStatus, label: t('track.step_en_route'), step: 3 },
    { key: 'arrived_at_pickup' as RideStatus, label: t('track.step_arrived'), step: 4 },
    { key: 'in_progress' as RideStatus, label: t('track.step_in_progress'), step: 5 },
    { key: 'completed' as RideStatus, label: t('track.step_completed'), step: 6 },
  ], [t]);
}

export default function SharedTrackingPage() {
  const { t } = useTranslation('web');
  const params = useParams();
  const token = params.token as string;
  const [ride, setRide] = useState<RideWithDriver | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [driverLocation, setDriverLocation] = useState<{ lat: number; lng: number } | null>(null);
  const statusSteps = useStatusSteps();

  const fetchRide = useCallback(async () => {
    try {
      const data = await rideService.getRideByShareToken(token);
      if (data) {
        setRide(data);
      } else {
        setError(t('track.invalid_link'));
      }
    } catch {
      setError(t('track.error_loading_tracking'));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    fetchRide();
    // Polling fallback since we may not have the ride ID yet for subscription
    const interval = setInterval(fetchRide, 10_000);
    return () => clearInterval(interval);
  }, [fetchRide]);

  // Subscribe to real-time updates once we have the ride
  useEffect(() => {
    if (!ride) return;
    const channel = rideService.subscribeToRide(ride.id, (updated) => {
      setRide((prev) => (prev ? { ...prev, ...updated } : null));
    });
    return () => { channel.unsubscribe(); };
  }, [ride?.id]);

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
        <p style={{ color: '#888', fontSize: '1.125rem' }}>{t('track.loading_tracking')}</p>
      </main>
    );
  }

  if (error || !ride) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '1.5rem' }}>
        <p style={{ color: 'var(--primary-dark)', fontSize: '1.125rem', marginBottom: '1rem' }}>{error ?? t('track.not_found_short')}</p>
        <Link href="/" style={{ color: 'var(--primary)', textDecoration: 'none' }}>{t('track.go_tricigo')}</Link>
      </main>
    );
  }

  const currentStepIdx = statusSteps.findIndex((s) => s.key === ride.status);
  const isCanceled = ride.status === 'canceled';
  const isCompleted = ride.status === 'completed';
  const isTerminal = isCanceled || isCompleted || ride.status === 'disputed';

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '1.5rem',
        background: '#FAFAFA',
      }}
    >
      <div style={{ maxWidth: 500, width: '100%' }}>
        {/* Brand header */}
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800 }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </h1>
          <p style={{ fontSize: '0.8rem', color: '#888' }}>{t('track.shared_tracking')}</p>
        </div>

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

        {/* Status */}
        {isCanceled ? (
          <div style={{ padding: '1rem', background: '#FEE', borderRadius: '0.75rem', textAlign: 'center', marginBottom: '1.5rem' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 36, height: 36, borderRadius: '50%',
              background: 'var(--primary-dark)', color: 'white', fontWeight: 700, fontSize: '1rem',
            }}>
              X
            </span>
            <p style={{ fontWeight: 700, marginTop: '0.5rem' }}>{t('track.canceled')}</p>
          </div>
        ) : (
          <div
            style={{
              padding: '1rem',
              background: 'white',
              borderRadius: '0.75rem',
              border: '1px solid #eee',
              marginBottom: '1.5rem',
            }}
          >
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
                    padding: '0.5rem 0',
                    opacity: isDone || isActive ? 1 : 0.3,
                  }}
                >
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: isActive ? 'var(--primary)' : isDone ? '#4CAF50' : '#eee',
                      color: isDone || isActive ? 'white' : '#aaa',
                      fontWeight: 700,
                      fontSize: '0.7rem',
                      flexShrink: 0,
                    }}
                  >
                    {isDone ? '✓' : step.step}
                  </span>
                  <span style={{ fontWeight: isActive ? 700 : 400, fontSize: '0.85rem' }}>
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Route */}
        <div
          style={{
            padding: '1rem',
            background: 'white',
            borderRadius: '0.75rem',
            border: '1px solid #eee',
            marginBottom: '1rem',
          }}
        >
          <div style={{ marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '0.7rem', color: '#888', display: 'block' }}>{t('track.from')}</span>
            <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{ride.pickup_address}</span>
          </div>
          <div>
            <span style={{ fontSize: '0.7rem', color: '#888', display: 'block' }}>{t('track.to')}</span>
            <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{ride.dropoff_address}</span>
          </div>
        </div>

        {/* Driver info */}
        {ride.driver_name && (
          <div
            style={{
              padding: '1rem',
              background: 'white',
              borderRadius: '0.75rem',
              border: '1px solid #eee',
              marginBottom: '1rem',
            }}
          >
            <span style={{ fontSize: '0.7rem', color: '#888', display: 'block', marginBottom: '0.5rem' }}>
              {t('track.driver')}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: 'var(--primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'white',
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {ride.driver_name.charAt(0).toUpperCase()}
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{ride.driver_name}</div>
                {ride.vehicle_make && (
                  <div style={{ fontSize: '0.75rem', color: '#666' }}>
                    {ride.vehicle_color} {ride.vehicle_make} {ride.vehicle_model}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Fare */}
        <div
          style={{
            padding: '1rem',
            background: 'white',
            borderRadius: '0.75rem',
            border: '1px solid #eee',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ color: '#666', fontSize: '0.8rem' }}>
            {isTerminal ? t('track.fare') : t('track.estimated')}
          </span>
          <span style={{ fontWeight: 800, fontSize: '1.125rem', color: 'var(--primary)' }}>
            {formatCUP(ride.final_fare_cup ?? ride.estimated_fare_cup)}
          </span>
        </div>

        {/* Live indicator */}
        {!isTerminal && (
          <p style={{ textAlign: 'center', fontSize: '0.7rem', color: '#888', marginTop: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}>
            <span style={{
              display: 'inline-block', width: 8, height: 8,
              borderRadius: '50%', background: '#4CAF50',
            }} />
            {t('track.live_updates')}
          </p>
        )}

        {/* CTA */}
        <div style={{ textAlign: 'center', marginTop: '2rem' }}>
          <Link
            href="/book"
            style={{
              display: 'inline-block',
              background: 'var(--primary)',
              color: 'white',
              padding: '0.75rem 2rem',
              borderRadius: '0.75rem',
              fontSize: '0.9rem',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            {t('track.cta_book')}
          </Link>
        </div>
      </div>
    </main>
  );
}
