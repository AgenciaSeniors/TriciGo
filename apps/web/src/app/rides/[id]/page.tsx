'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { rideService, getSupabaseClient } from '@tricigo/api';
import { formatTRC, formatTRCasUSD, formatCUP, getRelativeDay, formatTime, formatDate } from '@tricigo/utils';
import type { RideWithDriver } from '@tricigo/types';

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string }> = {
  searching: { label: 'Buscando conductor', bg: '#fef3c7', color: '#d97706' },
  accepted: { label: 'Aceptado', bg: '#dbeafe', color: '#2563eb' },
  driver_en_route: { label: 'Conductor en camino', bg: '#dbeafe', color: '#2563eb' },
  arrived_at_pickup: { label: 'Conductor llego', bg: '#dbeafe', color: '#2563eb' },
  in_progress: { label: 'En curso', bg: '#dbeafe', color: '#2563eb' },
  completed: { label: 'Completado', bg: '#dcfce7', color: '#16a34a' },
  canceled: { label: 'Cancelado', bg: '#fee2e2', color: '#dc2626' },
  disputed: { label: 'Disputado', bg: '#fef3c7', color: '#d97706' },
};

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Efectivo',
  tricicoin: 'TriciCoin',
  mixed: 'Mixto',
  tropipay: 'TropiPay',
  corporate: 'Corporativo',
};

const SERVICE_LABELS: Record<string, string> = {
  triciclo_basico: 'Triciclo Basico',
  triciclo_premium: 'Triciclo Premium',
  moto_standard: 'Moto Estandar',
  auto_standard: 'Auto Estandar',
  auto_premium: 'Auto Premium',
};

export default function RideDetailPage() {
  const router = useRouter();
  const params = useParams();
  const rideId = params?.id as string | undefined;

  // ── Auth state ──
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // ── Data state ──
  const [ride, setRide] = useState<RideWithDriver | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Auth effect ──
  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  // ── Load ride ──
  useEffect(() => {
    if (!userId || !rideId) return;
    let cancelled = false;

    async function loadRide() {
      setLoading(true);
      setError(null);
      try {
        const data = await rideService.getRideWithDriver(rideId!);
        if (!cancelled) {
          if (!data) {
            setError('Viaje no encontrado');
          } else {
            setRide(data);
          }
        }
      } catch (err) {
        console.error('Failed to load ride:', err);
        if (!cancelled) setError('Error al cargar el viaje');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadRide();
    return () => { cancelled = true; };
  }, [userId, rideId]);

  // ── Auth gate (after all hooks) ──
  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#999' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </div>
          <p style={{ fontSize: '0.875rem' }}>Cargando...</p>
        </div>
      </div>
    );
  }
  if (!userId) { router.replace('/login'); return null; }

  return (
    <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '1rem' }}>
      <div style={{ maxWidth: 500, width: '100%' }}>
        <Link href="/rides" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>
          &larr; Historial de viajes
        </Link>

        <h1 style={{ fontSize: 'clamp(1.25rem, 4vw, 1.75rem)', fontWeight: 800, marginTop: '1rem', marginBottom: '1.5rem' }}>
          Detalle del viaje
        </h1>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '3rem 0', color: '#999' }}>
            <div style={{
              width: 32, height: 32, border: '3px solid #eee', borderTopColor: 'var(--primary)',
              borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 0.75rem',
            }} />
            <p style={{ fontSize: '0.875rem' }}>Cargando viaje...</p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: '#999' }}>
            <p style={{ fontSize: '1rem', fontWeight: 600, color: '#dc2626' }}>{error}</p>
            <Link
              href="/rides"
              style={{
                display: 'inline-block', marginTop: '1rem', padding: '0.75rem 1.5rem',
                background: 'var(--primary)', color: 'white', borderRadius: '0.75rem',
                textDecoration: 'none', fontWeight: 600, fontSize: '0.875rem',
              }}
            >
              Volver al historial
            </Link>
          </div>
        )}

        {/* Ride detail */}
        {!loading && ride && (() => {
          const statusInfo = STATUS_CONFIG[ride.status] ?? { label: ride.status, bg: '#f3f4f6', color: '#666' };

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Status badge */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{
                  fontSize: '0.8rem', fontWeight: 600, padding: '0.3rem 0.75rem',
                  borderRadius: '1rem', background: statusInfo.bg, color: statusInfo.color,
                }}>
                  {statusInfo.label}
                </span>
                <span style={{ fontSize: '0.8rem', color: '#999' }}>
                  {SERVICE_LABELS[ride.service_type] ?? ride.service_type}
                </span>
              </div>

              {/* Addresses */}
              <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid #eee', background: 'white' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', flexShrink: 0, marginTop: 4 }} />
                    <div>
                      <p style={{ fontSize: '0.75rem', color: '#999', margin: 0 }}>Recogida</p>
                      <p style={{ fontSize: '0.875rem', color: '#333', margin: 0 }}>{ride.pickup_address}</p>
                    </div>
                  </div>
                  <div style={{ borderLeft: '2px dashed #ddd', marginLeft: 4, height: 16 }} />
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', flexShrink: 0, marginTop: 4 }} />
                    <div>
                      <p style={{ fontSize: '0.75rem', color: '#999', margin: 0 }}>Destino</p>
                      <p style={{ fontSize: '0.875rem', color: '#333', margin: 0 }}>{ride.dropoff_address}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Driver info */}
              {ride.driver_name && (
                <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid #eee', background: 'white' }}>
                  <p style={{ fontSize: '0.75rem', color: '#999', margin: '0 0 0.5rem' }}>Conductor</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: '50%', background: '#f3f4f6',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '1.25rem', fontWeight: 700, color: 'var(--primary)', flexShrink: 0,
                      overflow: 'hidden',
                    }}>
                      {ride.driver_avatar_url
                        ? <img src={ride.driver_avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : ride.driver_name.charAt(0).toUpperCase()
                      }
                    </div>
                    <div>
                      <p style={{ fontSize: '0.95rem', fontWeight: 600, margin: 0 }}>{ride.driver_name}</p>
                      {ride.driver_rating != null && (
                        <p style={{ fontSize: '0.8rem', color: '#999', margin: 0 }}>
                          ★ {ride.driver_rating.toFixed(1)}
                          {ride.driver_total_rides != null && ` · ${ride.driver_total_rides} viajes`}
                        </p>
                      )}
                    </div>
                  </div>
                  {(ride.vehicle_make || ride.vehicle_plate) && (
                    <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: '#666' }}>
                      {[
                        ride.vehicle_color,
                        [ride.vehicle_make, ride.vehicle_model].filter(Boolean).join(' '),
                        ride.vehicle_year,
                      ].filter(Boolean).join(' · ')}
                      {ride.vehicle_plate && (
                        <span style={{
                          marginLeft: '0.5rem', padding: '0.15rem 0.4rem', background: '#f3f4f6',
                          borderRadius: '0.25rem', fontWeight: 600, fontSize: '0.75rem',
                        }}>
                          {ride.vehicle_plate}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Fare breakdown */}
              <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid #eee', background: 'white' }}>
                <p style={{ fontSize: '0.75rem', color: '#999', margin: '0 0 0.75rem' }}>Tarifa</p>

                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span style={{ fontSize: '0.85rem', color: '#666' }}>Estimada</span>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                    {formatTRC(ride.estimated_fare_trc ?? 0)}
                    <span style={{ color: '#999', fontWeight: 400, marginLeft: '0.35rem', fontSize: '0.75rem' }}>
                      ({formatCUP(ride.estimated_fare_cup)})
                    </span>
                  </span>
                </div>

                {ride.final_fare_trc != null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <span style={{ fontSize: '0.85rem', color: '#666' }}>Final</span>
                    <span style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--primary)' }}>
                      {formatTRC(ride.final_fare_trc)}
                      <span style={{ color: '#999', fontWeight: 400, marginLeft: '0.35rem', fontSize: '0.75rem' }}>
                        ({formatCUP(ride.final_fare_cup ?? 0)})
                      </span>
                    </span>
                  </div>
                )}

                {ride.final_fare_trc != null && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <span style={{ fontSize: '0.75rem', color: '#999' }}>
                      ~{formatTRCasUSD(ride.final_fare_trc)}
                    </span>
                  </div>
                )}

                {ride.surge_multiplier > 1 && (
                  <div style={{ marginTop: '0.35rem', fontSize: '0.75rem', color: '#d97706' }}>
                    Tarifa dinamica: {ride.surge_multiplier.toFixed(1)}x
                  </div>
                )}

                {ride.tip_amount > 0 && (
                  <div style={{ marginTop: '0.35rem', fontSize: '0.8rem', color: '#666' }}>
                    Propina: {formatTRC(ride.tip_amount)}
                  </div>
                )}
              </div>

              {/* Details */}
              <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid #eee', background: 'white' }}>
                <p style={{ fontSize: '0.75rem', color: '#999', margin: '0 0 0.75rem' }}>Detalles</p>

                {[
                  { label: 'Metodo de pago', value: PAYMENT_LABELS[ride.payment_method] ?? ride.payment_method },
                  { label: 'Fecha', value: `${formatDate(ride.created_at)} · ${formatTime(ride.created_at)}` },
                  { label: 'Tipo de servicio', value: SERVICE_LABELS[ride.service_type] ?? ride.service_type },
                  ride.actual_distance_m != null
                    ? { label: 'Distancia', value: `${(ride.actual_distance_m / 1000).toFixed(1)} km` }
                    : { label: 'Distancia estimada', value: `${(ride.estimated_distance_m / 1000).toFixed(1)} km` },
                  ride.actual_duration_s != null
                    ? { label: 'Duracion', value: `${Math.round(ride.actual_duration_s / 60)} min` }
                    : { label: 'Duracion estimada', value: `${Math.round(ride.estimated_duration_s / 60)} min` },
                ].map((item, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', color: '#999' }}>{item.label}</span>
                    <span style={{ fontSize: '0.8rem', fontWeight: 500, color: '#333' }}>{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </div>
    </main>
  );
}
