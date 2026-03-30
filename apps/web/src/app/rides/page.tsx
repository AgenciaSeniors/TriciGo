'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { rideService, getSupabaseClient } from '@tricigo/api';
import { formatTRC, getRelativeDay, formatTime } from '@tricigo/utils';
import type { Ride } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

const STATUS_LABELS: Record<string, { label: string; bg: string; color: string }> = {
  completed: { label: 'Completado', bg: 'rgba(34, 197, 94, 0.1)', color: 'var(--success)' },
  canceled: { label: 'Cancelado', bg: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)' },
};

const VEHICLE_ICONS: Record<string, string> = {
  triciclo: '/images/vehicles/triciclo.png',
  moto: '/images/vehicles/moto.png',
  auto: '/images/vehicles/auto.png',
  confort: '/images/vehicles/confort.png',
  mensajeria: '/images/vehicles/mensajeria.png',
};

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Efectivo',
  tricicoin: 'TriciCoin',
  mixed: 'Mixto',
  tropipay: 'TropiPay',
  corporate: 'Corporativo',
};

export default function RidesPage() {
  const router = useRouter();

  // ── Auth state ──
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // ── Data state ──
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // ── Auth effect ──
  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  // ── Load rides ──
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    async function loadRides() {
      setLoading(true);
      try {
        const data = await rideService.getRideHistory(userId!, 0, 20);
        if (!cancelled) {
          setRides(data);
          setHasMore(data.length >= 20);
          setPage(0);
        }
      } catch (err) {
        console.error('Failed to load rides:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadRides();
    return () => { cancelled = true; };
  }, [userId]);

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

  async function handleLoadMore() {
    if (!userId || loadingMore) return;
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const data = await rideService.getRideHistory(userId, nextPage, 20);
      setRides((prev) => [...prev, ...data]);
      setPage(nextPage);
      setHasMore(data.length >= 20);
    } catch (err) {
      console.error('Failed to load more rides:', err);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <main className="page-main">
      <div className="page-container">
        <Link href="/" aria-label="Volver al inicio" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>
          &larr; Inicio
        </Link>

        <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, marginTop: '1rem', marginBottom: '1.5rem' }}>
          Historial de viajes
        </h1>

        {/* Loading */}
        {loading && <WebSkeletonList count={4} />}

        {/* Empty state */}
        {!loading && rides.length === 0 && (
          <WebEmptyState
            icon="🚗"
            title="Sin viajes todavia"
            description="Cuando completes un viaje, aparecera aqui."
            action={{ label: 'Solicitar un viaje', href: '/book' }}
          />
        )}

        {/* Ride list */}
        {!loading && rides.length > 0 && (
          <div className="rides-list">
            {rides.map((ride) => {
              const statusInfo = STATUS_LABELS[ride.status] ?? { label: ride.status, bg: '#f3f4f6', color: '#666' };
              return (
                <div
                  key={ride.id}
                  className="ride-card"
                  role="button"
                  tabIndex={0}
                  aria-label={`Ver detalle del viaje de ${ride.pickup_address} a ${ride.dropoff_address}`}
                  onClick={() => router.push(`/rides/${ride.id}`)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') router.push(`/rides/${ride.id}`); }}
                >
                  {/* Header: date + status */}
                  <div className="ride-card-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {VEHICLE_ICONS[(ride as any).service_type] && (
                        <img
                          src={VEHICLE_ICONS[(ride as any).service_type]}
                          alt={(ride as any).service_type}
                          style={{ width: 28, height: 28, objectFit: 'contain' }}
                        />
                      )}
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                        {getRelativeDay(ride.created_at, 'Hoy', 'Ayer')} &middot; {formatTime(ride.created_at)}
                      </span>
                    </div>
                    <span className="ride-status-badge" style={{ background: statusInfo.bg, color: statusInfo.color }}>
                      {statusInfo.label}
                    </span>
                  </div>

                  {/* Addresses with route dots */}
                  <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.5rem' }}>
                    <div className="ride-route-dots">
                      <span className="ride-route-dot ride-route-dot--pickup" />
                      <span className="ride-route-line" />
                      <span className="ride-route-dot ride-route-dot--dropoff" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ride.pickup_address}
                      </span>
                      <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ride.dropoff_address}
                      </span>
                    </div>
                  </div>

                  {/* Footer: fare + payment */}
                  <div className="ride-card-footer" style={{ paddingTop: '0.5rem', borderTop: '1px solid var(--border-light)' }}>
                    <span style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--primary)' }}>
                      {ride.final_fare_trc != null ? formatTRC(ride.final_fare_trc) : formatTRC(ride.estimated_fare_trc ?? 0)}
                    </span>
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                      {PAYMENT_LABELS[ride.payment_method] ?? ride.payment_method}
                    </span>
                  </div>
                </div>
              );
            })}

            {/* Load more */}
            {hasMore && (
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                aria-label="Cargar mas viajes"
                className="btn-base btn-secondary-outline"
                style={{ width: '100%', marginTop: '0.25rem' }}
              >
                {loadingMore ? <span className="spinner" style={{ width: 14, height: 14 }} /> : 'Cargar mas viajes'}
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
