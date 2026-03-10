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
  { key: 'driver_en_route', label: 'En camino al punto', icon: '🚗' },
  { key: 'arrived_at_pickup', label: 'Llegó al punto', icon: '📍' },
  { key: 'in_progress', label: 'Viaje en curso', icon: '🛣️' },
  { key: 'completed', label: 'Viaje completado', icon: '🏁' },
];

function getStepIndex(status: RideStatus): number {
  const idx = STATUS_STEPS.findIndex((s) => s.key === status);
  return idx >= 0 ? idx : -1;
}

export default function SharedTrackingPage() {
  const params = useParams();
  const token = params.token as string;
  const [ride, setRide] = useState<RideWithDriver | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRide = useCallback(async () => {
    try {
      const data = await rideService.getRideByShareToken(token);
      if (data) {
        setRide(data);
        // Once we have the ride, subscribe to real-time updates
      } else {
        setError('Enlace de seguimiento no válido o expirado.');
      }
    } catch {
      setError('Error al cargar el seguimiento.');
    } finally {
      setLoading(false);
    }
  }, [token]);

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

  if (loading) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#888', fontSize: '1.125rem' }}>Cargando seguimiento...</p>
      </main>
    );
  }

  if (error || !ride) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <p style={{ color: '#e04400', fontSize: '1.125rem', marginBottom: '1rem' }}>{error ?? 'No encontrado.'}</p>
        <Link href="/" style={{ color: 'var(--primary)', textDecoration: 'none' }}>← Ir a TriciGo</Link>
      </main>
    );
  }

  const currentStepIdx = getStepIndex(ride.status);
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
        padding: '2rem',
        background: '#FAFAFA',
      }}
    >
      <div style={{ maxWidth: 500, width: '100%' }}>
        {/* Brand header */}
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800 }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </h1>
          <p style={{ fontSize: '0.8rem', color: '#888' }}>Seguimiento compartido</p>
        </div>

        {/* Status */}
        {isCanceled ? (
          <div style={{ padding: '1rem', background: '#FEE', borderRadius: '0.75rem', textAlign: 'center', marginBottom: '1.5rem' }}>
            <span style={{ fontSize: '1.5rem' }}>❌</span>
            <p style={{ fontWeight: 700, marginTop: '0.5rem' }}>Viaje cancelado</p>
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
                    {isDone ? '✓' : step.icon}
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
            <span style={{ fontSize: '0.7rem', color: '#888', display: 'block' }}>Desde</span>
            <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{ride.pickup_address}</span>
          </div>
          <div>
            <span style={{ fontSize: '0.7rem', color: '#888', display: 'block' }}>Hasta</span>
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
              Conductor
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: '#FF4D00',
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
            {isTerminal ? 'Tarifa' : 'Estimado'}
          </span>
          <span style={{ fontWeight: 800, fontSize: '1.125rem', color: 'var(--primary)' }}>
            {formatCUP(ride.final_fare_cup ?? ride.estimated_fare_cup)}
          </span>
        </div>

        {/* Live indicator */}
        {!isTerminal && (
          <p style={{ textAlign: 'center', fontSize: '0.7rem', color: '#888', marginTop: '1rem' }}>
            🟢 Actualizando en tiempo real
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
            Pide tu viaje con TriciGo
          </Link>
        </div>
      </div>
    </main>
  );
}
