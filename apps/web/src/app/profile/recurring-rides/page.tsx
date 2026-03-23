'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseClient, recurringRideService } from '@tricigo/api';
import type { RecurringRide } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

const DAY_LABELS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

function formatNextOccurrence(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('es-CU', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function RecurringRidesPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [rides, setRides] = useState<RecurringRide[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  const fetchRides = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await recurringRideService.getRecurringRides(userId);
      setRides(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) fetchRides();
  }, [userId, fetchRides]);

  const handlePause = async (id: string) => {
    setActionLoading(id);
    try {
      await recurringRideService.pauseRecurringRide(id);
      await fetchRides();
    } catch { /* best-effort */ }
    setActionLoading(null);
  };

  const handleResume = async (id: string) => {
    setActionLoading(id);
    try {
      await recurringRideService.resumeRecurringRide(id);
      await fetchRides();
    } catch { /* best-effort */ }
    setActionLoading(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Eliminar este viaje recurrente?')) return;
    setActionLoading(id);
    try {
      await recurringRideService.deleteRecurringRide(id);
      await fetchRides();
    } catch { /* best-effort */ }
    setActionLoading(null);
  };

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>Cargando...</p>
      </div>
    );
  }

  if (!userId) {
    router.replace('/login');
    return null;
  }

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" aria-label="Volver al perfil" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>Viajes recurrentes</h1>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '0.75rem', padding: '1rem', marginBottom: '1.5rem' }}>
          <p style={{ color: '#c53030', margin: 0, fontSize: '0.9rem' }}>{error}</p>
          <button onClick={() => { setError(null); fetchRides(); }} style={{ marginTop: '0.5rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem' }}>
            Reintentar
          </button>
        </div>
      )}

      {loading ? (
        <WebSkeletonList count={3} />
      ) : rides.length === 0 ? (
        <WebEmptyState
          icon="🔁"
          title="Sin viajes recurrentes"
          description="Programa viajes que se repitan automaticamente cada semana."
          action={{ label: 'Solicitar un viaje', href: '/book' }}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {rides.map((ride) => (
            <div key={ride.id} style={{
              background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', padding: '1.25rem',
            }}>
              {/* Route */}
              <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: '0.75rem', gap: '0.5rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 4, flexShrink: 0 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--primary)' }} />
                  <div style={{ width: 1, height: 12, background: 'var(--border)' }} />
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--text-tertiary)' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ride.pickup_address}</p>
                  <div style={{ height: 4 }} />
                  <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ride.dropoff_address}</p>
                </div>
                <span style={{
                  flexShrink: 0, fontSize: '0.7rem', fontWeight: 600, padding: '0.2rem 0.5rem', borderRadius: '999px',
                  background: ride.status === 'active' ? '#f0fdf4' : '#f5f5f5',
                  color: ride.status === 'active' ? '#16a34a' : '#737373',
                  border: ride.status === 'active' ? '1px solid #bbf7d0' : '1px solid #e5e5e5',
                }}>
                  {ride.status === 'active' ? 'Activo' : 'Pausado'}
                </span>
              </div>

              {/* Days of week */}
              <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                  const isActive = ride.days_of_week.includes(day);
                  return (
                    <span key={day} style={{
                      width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.75rem', fontWeight: 600,
                      background: isActive ? 'var(--primary)' : 'var(--border-light)',
                      color: isActive ? '#fff' : 'var(--text-tertiary)',
                    }}>
                      {DAY_LABELS[day - 1]}
                    </span>
                  );
                })}
                <span style={{ marginLeft: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{ride.time_of_day}</span>
              </div>

              {/* Next occurrence */}
              {ride.next_occurrence_at && (
                <p style={{ margin: '0 0 0.75rem', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                  Proximo: {formatNextOccurrence(ride.next_occurrence_at)}
                </p>
              )}

              {/* Actions */}
              <div style={{ display: 'flex', gap: '0.5rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-light)' }}>
                {actionLoading === ride.id ? (
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>Procesando...</span>
                ) : (
                  <>
                    <button
                      onClick={() => ride.status === 'active' ? handlePause(ride.id) : handleResume(ride.id)}
                      aria-label={ride.status === 'active' ? 'Pausar viaje recurrente' : 'Reanudar viaje recurrente'}
                      style={{
                        padding: '0.4rem 0.75rem', borderRadius: '0.5rem', fontSize: '0.8rem', fontWeight: 500,
                        background: 'var(--border-light)', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer',
                      }}
                    >
                      {ride.status === 'active' ? 'Pausar' : 'Reanudar'}
                    </button>
                    <button
                      onClick={() => handleDelete(ride.id)}
                      aria-label="Eliminar viaje recurrente"
                      style={{
                        padding: '0.4rem 0.75rem', borderRadius: '0.5rem', fontSize: '0.8rem', fontWeight: 500,
                        background: '#fef2f2', color: '#dc2626', border: 'none', cursor: 'pointer',
                      }}
                    >
                      Eliminar
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
