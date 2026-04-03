'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { rideService, getSupabaseClient } from '@tricigo/api';
import { formatTRC, getRelativeDay, formatTime } from '@tricigo/utils';
import type { Ride } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

/* ── Constants ── */
const PAGE_SIZE = 20;

const SERVICE_LABELS: Record<string, string> = {
  triciclo_basico: 'Triciclo',
  triciclo_premium: 'Triciclo Premium',
  triciclo_cargo: 'Triciclo Cargo',
  moto_standard: 'Moto',
  auto_standard: 'Auto',
  auto_confort: 'Confort',
  mensajeria: 'Envío',
};

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Efectivo',
  tricicoin: 'TriciCoin',
  mixed: 'Mixto',
  tropipay: 'TropiPay',
  corporate: 'Corporativo',
};

function getVehicleIcon(serviceType: string): string {
  if (serviceType.startsWith('triciclo')) return '/images/vehicles/triciclo.png';
  if (serviceType.startsWith('moto')) return '/images/vehicles/moto.png';
  if (serviceType.startsWith('auto')) return '/images/vehicles/auto.png';
  if (serviceType === 'mensajeria') return '/images/vehicles/mensajeria.png';
  return '/images/vehicles/auto.png';
}

type TabFilter = 'all' | 'completed' | 'canceled';

const TABS: { key: TabFilter; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'completed', label: 'Completados' },
  { key: 'canceled', label: 'Cancelados' },
];

/* ── Date Grouping ── */
function groupRidesByDate(rides: Ride[]): { label: string; rides: Ride[] }[] {
  const groups: Map<string, Ride[]> = new Map();
  for (const ride of rides) {
    const label = getRelativeDay(ride.created_at, 'Hoy', 'Ayer');
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(ride);
  }
  return Array.from(groups.entries()).map(([label, groupRides]) => ({ label, rides: groupRides }));
}

/* ── Page Component ── */
export default function RidesPage() {
  const router = useRouter();

  // Auth
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Data
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Filters
  const [activeTab, setActiveTab] = useState<TabFilter>('all');

  // Auth
  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  // Load rides
  const loadRides = useCallback(async (uid: string, tab: TabFilter, pg: number, append: boolean) => {
    if (!append) setLoading(true);
    else setLoadingMore(true);

    try {
      const data = await rideService.getRideHistoryFiltered({
        userId: uid,
        page: pg,
        pageSize: PAGE_SIZE,
        ...(tab !== 'all' && { status: [tab] }),
      });
      if (append) {
        setRides((prev) => [...prev, ...data]);
      } else {
        setRides(data);
      }
      setHasMore(data.length >= PAGE_SIZE);
      setPage(pg);
    } catch (err) {
      console.error('Failed to load rides:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (!userId) return;
    loadRides(userId, activeTab, 0, false);
  }, [userId, activeTab, loadRides]);

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !userId) router.replace('/login');
  }, [authLoading, userId, router]);

  // Auth gate
  if (authLoading || !userId) {
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

  const handleLoadMore = () => {
    if (loadingMore) return;
    loadRides(userId, activeTab, page + 1, true);
  };

  const handleTabChange = (tab: TabFilter) => {
    if (tab === activeTab) return;
    setActiveTab(tab);
    setRides([]);
    setPage(0);
  };

  const dateGroups = groupRidesByDate(rides);
  let globalCardIdx = 0;

  return (
    <main className="page-main">
      <div className="page-container">
        <Link href="/" aria-label="Volver al inicio" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>
          &larr; Inicio
        </Link>

        <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, marginTop: '1rem', marginBottom: '1.25rem' }}>
          Historial de viajes
        </h1>

        {/* Filter Tabs */}
        <div className="rides-filter-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={`rides-filter-tab ${activeTab === tab.key ? 'rides-filter-tab--active' : ''}`}
              onClick={() => handleTabChange(tab.key)}
              aria-pressed={activeTab === tab.key}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Loading */}
        {loading && <WebSkeletonList count={4} />}

        {/* Empty */}
        {!loading && rides.length === 0 && (
          <WebEmptyState
            icon="🚗"
            title={activeTab === 'all' ? 'Sin viajes todavía' : activeTab === 'completed' ? 'Sin viajes completados' : 'Sin viajes cancelados'}
            description={activeTab === 'all' ? 'Cuando completes un viaje, aparecerá aquí.' : 'No hay viajes con este filtro.'}
            action={{ label: 'Solicitar un viaje', href: '/book' }}
          />
        )}

        {/* Ride list grouped by date */}
        {!loading && rides.length > 0 && (
          <div>
            {dateGroups.map((group) => (
              <div key={group.label}>
                <div className="rides-date-header">{group.label}</div>
                <div className="rides-list">
                  {group.rides.map((ride) => {
                    const cardIdx = globalCardIdx++;
                    const statusClass = ride.status === 'completed' ? 'ride-status-badge--completed' : 'ride-status-badge--canceled';
                    const statusLabel = ride.status === 'completed' ? 'Completado' : 'Cancelado';
                    const serviceType = (ride as any).service_type ?? '';

                    return (
                      <div
                        key={ride.id}
                        className="ride-card"
                        role="button"
                        tabIndex={0}
                        style={{ animationDelay: `${Math.min(cardIdx * 0.05, 0.4)}s` }}
                        aria-label={`Ver viaje de ${ride.pickup_address} a ${ride.dropoff_address}`}
                        onClick={() => router.push(`/rides/${ride.id}`)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') router.push(`/rides/${ride.id}`); }}
                      >
                        {/* Header */}
                        <div className="ride-card-header">
                          <div className="ride-card-meta">
                            <div className="ride-vehicle-icon">
                              <img src={getVehicleIcon(serviceType)} alt={serviceType} />
                            </div>
                            <div className="ride-card-meta-text">
                              <span className="ride-card-service-label">
                                {SERVICE_LABELS[serviceType] ?? serviceType}
                              </span>
                              <span className="ride-card-time">
                                {formatTime(ride.created_at)}
                              </span>
                            </div>
                          </div>
                          <span className={`ride-status-badge ${statusClass}`}>
                            {statusLabel}
                          </span>
                        </div>

                        {/* Route */}
                        <div className="ride-route">
                          <div className="ride-route-dots">
                            <span className="ride-route-dot ride-route-dot--pickup" />
                            <span className="ride-route-line" />
                            <span className="ride-route-dot ride-route-dot--dropoff" />
                          </div>
                          <div className="ride-route-addresses">
                            <div>
                              <div className="ride-address-label">Desde</div>
                              <div className="ride-address">{ride.pickup_address}</div>
                            </div>
                            <div>
                              <div className="ride-address-label">Hasta</div>
                              <div className="ride-address">{ride.dropoff_address}</div>
                            </div>
                          </div>
                        </div>

                        {/* Footer */}
                        <div className="ride-card-footer">
                          <span className="ride-fare">
                            {ride.final_fare_trc != null ? formatTRC(ride.final_fare_trc) : formatTRC(ride.estimated_fare_trc ?? 0)}
                          </span>
                          <div className="ride-card-footer-right">
                            {ride.estimated_distance_m != null && ride.estimated_distance_m > 0 && (
                              <span className="ride-distance">
                                {(ride.estimated_distance_m / 1000).toFixed(1)} km
                              </span>
                            )}
                            <span className="ride-payment-label">
                              {PAYMENT_LABELS[ride.payment_method] ?? ride.payment_method}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Load more */}
            {hasMore && (
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                aria-label="Cargar más viajes"
                className="btn-base btn-secondary-outline"
                style={{ width: '100%', marginTop: '1rem' }}
              >
                {loadingMore ? <span className="spinner" style={{ width: 14, height: 14 }} /> : 'Cargar más viajes'}
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
