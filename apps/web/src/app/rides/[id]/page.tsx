'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { rideService, getSupabaseClient } from '@tricigo/api';
import { formatTRC, formatTRCasUSD, formatCUP, getRelativeDay, formatTime, formatDate } from '@tricigo/utils';
import type { RideWithDriver } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';

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
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
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
        <Link href="/rides" aria-label="Volver al historial de viajes" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>
          &larr; Historial de viajes
        </Link>

        <h1 style={{ fontSize: 'clamp(1.25rem, 4vw, 1.75rem)', fontWeight: 800, marginTop: '1rem', marginBottom: '1.5rem' }}>
          Detalle del viaje
        </h1>

        {/* Loading */}
        {loading && <WebSkeletonList count={3} />}

        {/* Error */}
        {!loading && error && (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-tertiary)' }}>
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
          const statusInfo = STATUS_CONFIG[ride.status] ?? { label: ride.status, bg: '#f3f4f6', color: 'var(--text-secondary)' };

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
                <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                  {SERVICE_LABELS[ride.service_type] ?? ride.service_type}
                </span>
              </div>

              {/* Addresses */}
              <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--success)', flexShrink: 0, marginTop: 4 }} />
                    <div>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: 0 }}>Recogida</p>
                      <p style={{ fontSize: '0.875rem', color: 'var(--text-primary)', margin: 0 }}>{ride.pickup_address}</p>
                    </div>
                  </div>
                  <div style={{ borderLeft: '2px dashed var(--border)', marginLeft: 4, height: 16 }} />
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--error)', flexShrink: 0, marginTop: 4 }} />
                    <div>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: 0 }}>Destino</p>
                      <p style={{ fontSize: '0.875rem', color: 'var(--text-primary)', margin: 0 }}>{ride.dropoff_address}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Driver info */}
              {ride.driver_name && (
                <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.5rem' }}>Conductor</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: '50%', background: 'var(--bg-hover)',
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
                        <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', margin: 0 }}>
                          ★ {ride.driver_rating.toFixed(1)}
                          {ride.driver_total_rides != null && ` · ${ride.driver_total_rides} viajes`}
                        </p>
                      )}
                    </div>
                  </div>
                  {(ride.vehicle_make || ride.vehicle_plate) && (
                    <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {[
                        ride.vehicle_color,
                        [ride.vehicle_make, ride.vehicle_model].filter(Boolean).join(' '),
                        ride.vehicle_year,
                      ].filter(Boolean).join(' · ')}
                      {ride.vehicle_plate && (
                        <span style={{
                          marginLeft: '0.5rem', padding: '0.15rem 0.4rem', background: 'var(--bg-hover)',
                          borderRadius: '0.25rem', fontWeight: 600, fontSize: '0.75rem',
                        }}>
                          {ride.vehicle_plate}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Status timestamps (W4.5) */}
              {(() => {
                const timestamps: { label: string; time: string | null; icon: string }[] = [
                  { label: 'Solicitado', time: ride.created_at, icon: '📝' },
                  { label: 'Aceptado', time: ride.accepted_at, icon: '✅' },
                  { label: 'Conductor llego', time: ride.driver_arrived_at, icon: '📍' },
                  { label: 'Recogida', time: ride.pickup_at, icon: '🚗' },
                  { label: 'Completado', time: ride.completed_at, icon: '🏁' },
                  { label: 'Cancelado', time: ride.canceled_at, icon: '❌' },
                ].filter((ts) => ts.time != null);

                if (timestamps.length === 0) return null;

                return (
                  <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Cronologia del viaje</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                      {timestamps.map((ts, idx) => (
                        <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                            <span style={{ fontSize: '1rem' }} aria-hidden="true">{ts.icon}</span>
                            {idx < timestamps.length - 1 && (
                              <div style={{ width: 1, height: 20, background: 'var(--border)', marginTop: 2 }} />
                            )}
                          </div>
                          <div style={{ paddingBottom: idx < timestamps.length - 1 ? '0.5rem' : 0 }}>
                            <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>{ts.label}</p>
                            <p style={{ margin: '0.1rem 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                              {formatDate(ts.time!)} · {formatTime(ts.time!)}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                    {ride.canceled_at && ride.cancellation_reason && (
                      <p style={{ margin: '0.75rem 0 0', fontSize: '0.8rem', color: 'var(--error)', fontStyle: 'italic' }}>
                        Motivo: {ride.cancellation_reason}
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Fare breakdown (W4.6) */}
              <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.75rem', textTransform: 'uppercase', fontWeight: 600 }}>Desglose de tarifa</p>

                {/* Base: Estimated fare */}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Tarifa base estimada</span>
                  <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>
                    {formatTRC(ride.estimated_fare_trc ?? 0)}
                    <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, marginLeft: '0.35rem', fontSize: '0.7rem' }}>
                      ({formatCUP(ride.estimated_fare_cup)})
                    </span>
                  </span>
                </div>

                {/* Distance charge */}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Distancia</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {ride.actual_distance_m != null
                      ? `${(ride.actual_distance_m / 1000).toFixed(1)} km`
                      : `${(ride.estimated_distance_m / 1000).toFixed(1)} km (est.)`}
                  </span>
                </div>

                {/* Duration charge */}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Tiempo</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {ride.actual_duration_s != null
                      ? `${Math.round(ride.actual_duration_s / 60)} min`
                      : `${Math.round(ride.estimated_duration_s / 60)} min (est.)`}
                  </span>
                </div>

                {/* Surge multiplier */}
                {ride.surge_multiplier > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', color: '#d97706', fontWeight: 600 }}>Tarifa dinamica</span>
                    <span style={{ fontSize: '0.8rem', color: '#d97706', fontWeight: 600 }}>
                      {ride.surge_multiplier.toFixed(1)}x
                    </span>
                  </div>
                )}

                {/* Discount */}
                {ride.discount_amount_cup > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--success)', fontWeight: 600 }}>Descuento</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--success)', fontWeight: 600 }}>
                      -{formatCUP(ride.discount_amount_cup)}
                    </span>
                  </div>
                )}

                {/* Wait time charge */}
                {ride.wait_time_charge_cup > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Cargo por espera ({ride.wait_time_minutes} min)</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {formatCUP(ride.wait_time_charge_cup)}
                    </span>
                  </div>
                )}

                {/* Insurance */}
                {ride.insurance_selected && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Seguro de viaje</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {ride.insurance_premium_cup ? formatCUP(ride.insurance_premium_cup) : 'Incluido'}
                    </span>
                  </div>
                )}

                {/* Tip */}
                {ride.tip_amount > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Propina</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {formatTRC(ride.tip_amount)}
                    </span>
                  </div>
                )}

                {/* Cancellation fee */}
                {ride.cancellation_fee_cup > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--error)', fontWeight: 600 }}>Tarifa de cancelacion</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--error)', fontWeight: 600 }}>
                      {formatCUP(ride.cancellation_fee_cup)}
                    </span>
                  </div>
                )}

                {/* Divider + Final fare */}
                {ride.final_fare_trc != null && (
                  <>
                    <div style={{ borderTop: '1px solid var(--border-light)', margin: '0.75rem 0' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>Total final</span>
                      <div style={{ textAlign: 'right' }}>
                        <span style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--primary)' }}>
                          {formatTRC(ride.final_fare_trc)}
                        </span>
                        <p style={{ margin: '0.15rem 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          {formatCUP(ride.final_fare_cup ?? 0)} · ~{formatTRCasUSD(ride.final_fare_trc)}
                        </p>
                      </div>
                    </div>
                  </>
                )}

                {/* Exchange rate */}
                {ride.exchange_rate_usd_cup && (
                  <p style={{ margin: '0.5rem 0 0', fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
                    Tasa al momento: 1 USD = {ride.exchange_rate_usd_cup} CUP
                  </p>
                )}
              </div>

              {/* Details */}
              <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)' }}>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.75rem' }}>Detalles</p>

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
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>{item.label}</span>
                    <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-primary)' }}>{item.value}</span>
                  </div>
                ))}
              </div>
              {/* Post-trip actions */}
              {ride.status === 'completed' && (
                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
                  <Link
                    href={`/rides/${ride.id}/dispute`}
                    style={{
                      flex: 1, textAlign: 'center', padding: '0.75rem', borderRadius: '0.75rem',
                      border: '1px solid var(--border-light)', background: 'var(--bg-card)',
                      color: 'var(--text-primary)', textDecoration: 'none',
                      fontSize: '0.85rem', fontWeight: 600,
                    }}
                  >
                    Reportar problema
                  </Link>
                  <Link
                    href={`/rides/${ride.id}/lost-item`}
                    style={{
                      flex: 1, textAlign: 'center', padding: '0.75rem', borderRadius: '0.75rem',
                      border: '1px solid var(--border-light)', background: 'var(--bg-card)',
                      color: 'var(--text-primary)', textDecoration: 'none',
                      fontSize: '0.85rem', fontWeight: 600,
                    }}
                  >
                    Objeto perdido
                  </Link>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </main>
  );
}
