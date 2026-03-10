'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { rideService } from '@tricigo/api';
import { formatCUP } from '@tricigo/utils';
import type { RideWithDriver, RideStatus } from '@tricigo/types';

const STATUS_STEPS: { key: RideStatus; label: string; icon: string }[] = [
  { key: 'searching', label: 'Buscando conductor', icon: '🔍' },
  { key: 'accepted', label: 'Conductor asignado', icon: '✅' },
  { key: 'driver_en_route', label: 'En camino a recogerte', icon: '🚗' },
  { key: 'arrived_at_pickup', label: 'Llegó al punto', icon: '📍' },
  { key: 'in_progress', label: 'Viaje en curso', icon: '🛣️' },
  { key: 'completed', label: 'Viaje completado', icon: '🏁' },
];

function getStepIndex(status: RideStatus): number {
  const idx = STATUS_STEPS.findIndex((s) => s.key === status);
  return idx >= 0 ? idx : -1;
}

export default function TrackRidePage() {
  const params = useParams();
  const rideId = params.id as string;
  const [ride, setRide] = useState<RideWithDriver | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRide = useCallback(async () => {
    try {
      const data = await rideService.getRideWithDriver(rideId);
      if (data) setRide(data);
      else setError('Viaje no encontrado.');
    } catch {
      setError('Error al cargar el viaje.');
    } finally {
      setLoading(false);
    }
  }, [rideId]);

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

  if (loading) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#888', fontSize: '1.125rem' }}>Cargando viaje...</p>
      </main>
    );
  }

  if (error || !ride) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <p style={{ color: '#e04400', fontSize: '1.125rem', marginBottom: '1rem' }}>{error ?? 'Viaje no encontrado.'}</p>
        <Link href="/" style={{ color: 'var(--primary)', textDecoration: 'none' }}>← Volver al inicio</Link>
      </main>
    );
  }

  const currentStepIdx = getStepIndex(ride.status);
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
          ← Inicio
        </Link>

        <h1 style={{ fontSize: '1.75rem', fontWeight: 800, marginTop: '1rem', marginBottom: '0.25rem' }}>
          Seguimiento de viaje
        </h1>
        <p style={{ color: '#888', fontSize: '0.8rem', marginBottom: '1.5rem' }}>
          ID: {ride.id.slice(0, 8)}...
        </p>

        {/* Status stepper */}
        {isCanceled ? (
          <div style={{ padding: '1rem', background: '#FEE', borderRadius: '0.75rem', textAlign: 'center', marginBottom: '1.5rem' }}>
            <span style={{ fontSize: '1.5rem' }}>❌</span>
            <p style={{ fontWeight: 700, marginTop: '0.5rem' }}>Viaje cancelado</p>
            {ride.cancellation_reason && (
              <p style={{ color: '#888', fontSize: '0.8rem', marginTop: '0.25rem' }}>{ride.cancellation_reason}</p>
            )}
          </div>
        ) : isDisputed ? (
          <div style={{ padding: '1rem', background: '#FFF3E0', borderRadius: '0.75rem', textAlign: 'center', marginBottom: '1.5rem' }}>
            <span style={{ fontSize: '1.5rem' }}>⚠️</span>
            <p style={{ fontWeight: 700, marginTop: '0.5rem' }}>Viaje en disputa</p>
          </div>
        ) : (
          <div style={{ marginBottom: '1.5rem' }}>
            {STATUS_STEPS.map((step, idx) => {
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
                    {isDone ? '✓' : step.icon}
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
            <span style={{ fontSize: '0.75rem', color: '#888', display: 'block' }}>Desde</span>
            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{ride.pickup_address}</span>
          </div>
          <div>
            <span style={{ fontSize: '0.75rem', color: '#888', display: 'block' }}>Hasta</span>
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
            {isTerminal ? 'Tarifa final' : 'Tarifa estimada'}
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
              Tu conductor
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: '50%',
                  background: '#FF4D00',
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

        {/* Live indicator */}
        {!isTerminal && (
          <p style={{ textAlign: 'center', fontSize: '0.75rem', color: '#888', marginTop: '1rem' }}>
            🟢 Actualizando en tiempo real
          </p>
        )}
      </div>
    </main>
  );
}
