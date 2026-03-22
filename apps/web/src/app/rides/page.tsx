'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { rideService, getSupabaseClient } from '@tricigo/api';
import { formatTRC, getRelativeDay, formatTime } from '@tricigo/utils';
import type { Ride } from '@tricigo/types';

const STATUS_LABELS: Record<string, { label: string; bg: string; color: string }> = {
  completed: { label: 'Completado', bg: '#dcfce7', color: '#16a34a' },
  canceled: { label: 'Cancelado', bg: '#fee2e2', color: '#dc2626' },
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
        <Link href="/" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>
          &larr; Inicio
        </Link>

        <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, marginTop: '1rem', marginBottom: '1.5rem' }}>
          Historial de viajes
        </h1>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '3rem 0', color: '#999' }}>
            <div style={{
              width: 32, height: 32, border: '3px solid #eee', borderTopColor: 'var(--primary)',
              borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 0.75rem',
            }} />
            <p style={{ fontSize: '0.875rem' }}>Cargando viajes...</p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {/* Empty state */}
        {!loading && rides.length === 0 && (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: '#999' }}>
            <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>🚗</div>
            <p style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>Sin viajes todavia</p>
            <p style={{ fontSize: '0.875rem' }}>Cuando completes un viaje, aparecera aqui.</p>
            <Link
              href="/book"
              style={{
                display: 'inline-block', marginTop: '1rem', padding: '0.75rem 1.5rem',
                background: 'var(--primary)', color: 'white', borderRadius: '0.75rem',
                textDecoration: 'none', fontWeight: 600, fontSize: '0.875rem',
              }}
            >
              Solicitar un viaje
            </Link>
          </div>
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
                  onClick={() => router.push(`/rides/${ride.id}`)}
                >
                  {/* Header: date + status */}
                  <div className="ride-card-header">
                    <span style={{ fontSize: '0.8rem', color: '#999' }}>
                      {getRelativeDay(ride.created_at, 'Hoy', 'Ayer')} &middot; {formatTime(ride.created_at)}
                    </span>
                    <span style={{
                      fontSize: '0.7rem', fontWeight: 600, padding: '0.2rem 0.5rem',
                      borderRadius: '1rem', background: statusInfo.bg, color: statusInfo.color,
                    }}>
                      {statusInfo.label}
                    </span>
                  </div>

                  {/* Addresses */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
                      <span style={{ fontSize: '0.85rem', color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ride.pickup_address}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
                      <span style={{ fontSize: '0.85rem', color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ride.dropoff_address}
                      </span>
                    </div>
                  </div>

                  {/* Footer: fare + payment */}
                  <div className="ride-card-footer">
                    <span style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--primary)' }}>
                      {ride.final_fare_trc != null ? formatTRC(ride.final_fare_trc) : formatTRC(ride.estimated_fare_trc ?? 0)}
                    </span>
                    <span style={{ fontSize: '0.75rem', color: '#999' }}>
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
                style={{
                  width: '100%', padding: '0.75rem', borderRadius: '0.75rem',
                  border: '1px solid #ddd', background: 'white', cursor: loadingMore ? 'not-allowed' : 'pointer',
                  fontSize: '0.875rem', fontWeight: 600, color: 'var(--primary)', marginTop: '0.25rem',
                }}
              >
                {loadingMore ? 'Cargando...' : 'Cargar mas viajes'}
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
