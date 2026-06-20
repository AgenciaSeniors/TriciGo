'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { rideService, getSupabaseClient } from '@tricigo/api';
import { formatTRC, formatCUP, getRelativeDay, formatTime, riderChargedTotal, riderChargedTotalTrc, generateHistoryCSV } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { Ride, ServiceTypeSlug, PaymentMethod } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

/* ── Constants ── */
const PAGE_SIZE = 20;

// Service slugs in display order — labels are resolved via `t` inside the
// component (i18n key rides.service_<slug>).
const SERVICE_SLUGS = [
  'triciclo_basico',
  'triciclo_premium',
  'triciclo_cargo',
  'moto_standard',
  'auto_standard',
  'auto_confort',
  'mensajeria',
] as const;

// Payment methods in display order — labels resolved via `t`
// (i18n key rides.payment_<method>).
const PAYMENT_METHODS = ['cash', 'tricicoin', 'mixed', 'corporate'] as const;

function getVehicleIcon(serviceType: string): string {
  if (serviceType.startsWith('triciclo')) return '/images/vehicles/triciclo.png';
  if (serviceType.startsWith('moto')) return '/images/vehicles/moto.png';
  if (serviceType.startsWith('auto')) return '/images/vehicles/auto.png';
  if (serviceType === 'mensajeria') return '/images/vehicles/mensajeria.png';
  return '/images/vehicles/auto.png';
}

type TabFilter = 'all' | 'completed' | 'canceled';

/* ── Page Component ── */
export default function RidesPage() {
  const { t } = useTranslation('web');
  const router = useRouter();

  // Service / payment labels (i18n). Slug → translated label, falling back
  // to the raw slug for unknown service types.
  const SERVICE_LABELS: Record<string, string> = {
    triciclo_basico: t('rides.service_triciclo_basico', { defaultValue: 'Triciclo' }),
    triciclo_premium: t('rides.service_triciclo_premium', { defaultValue: 'Triciclo Premium' }),
    triciclo_cargo: t('rides.service_triciclo_cargo', { defaultValue: 'Triciclo Cargo' }),
    moto_standard: t('rides.service_moto_standard', { defaultValue: 'Moto' }),
    auto_standard: t('rides.service_auto_standard', { defaultValue: 'Auto' }),
    auto_confort: t('rides.service_auto_confort', { defaultValue: 'Confort' }),
    mensajeria: t('rides.service_mensajeria', { defaultValue: 'Envío' }),
  };

  const PAYMENT_LABELS: Record<string, string> = {
    cash: t('rides.payment_cash', { defaultValue: 'Efectivo' }),
    tricicoin: t('rides.payment_tricicoin', { defaultValue: 'TriciCoin' }),
    mixed: t('rides.payment_mixed', { defaultValue: 'Mixto' }),
    corporate: t('rides.payment_corporate', { defaultValue: 'Corporativo' }),
  };

  const TABS: { key: TabFilter; label: string }[] = [
    { key: 'all', label: t('rides.tab_all', { defaultValue: 'Todos' }) },
    { key: 'completed', label: t('rides.tab_completed', { defaultValue: 'Completados' }) },
    { key: 'canceled', label: t('rides.tab_canceled', { defaultValue: 'Cancelados' }) },
  ];

  /* ── Date Grouping ── */
  const groupRidesByDate = (rides: Ride[]): { label: string; rides: Ride[] }[] => {
    const groups: Map<string, Ride[]> = new Map();
    for (const ride of rides) {
      const label = getRelativeDay(
        ride.created_at,
        t('rides.date_today', { defaultValue: 'Hoy' }),
        t('rides.date_yesterday', { defaultValue: 'Ayer' }),
      );
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(ride);
    }
    return Array.from(groups.entries()).map(([label, groupRides]) => ({ label, rides: groupRides }));
  };

  // Auth
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Data
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [activeTab, setActiveTab] = useState<TabFilter>('all');
  const [serviceFilter, setServiceFilter] = useState<string>('all');
  const [paymentFilter, setPaymentFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [showFilters, setShowFilters] = useState(false);

  // Auth
  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  // Load rides. Filters (status/service/payment/date) are passed as opts so
  // the service applies them server-side (getRideHistoryFiltered ya soporta
  // serviceType/paymentMethod/dateFrom/dateTo — parity con los filtros del
  // rides móvil).
  type LoadOpts = { tab: TabFilter; serviceType: string; paymentMethod: string; dateFrom: string; dateTo: string };
  const loadRides = useCallback(async (uid: string, pg: number, append: boolean, opts: LoadOpts) => {
    if (!append) { setLoading(true); setError(null); }
    else setLoadingMore(true);

    try {
      const data = await rideService.getRideHistoryFiltered({
        userId: uid,
        page: pg,
        pageSize: PAGE_SIZE,
        ...(opts.tab !== 'all' && { status: [opts.tab] }),
        ...(opts.serviceType !== 'all' && { serviceType: opts.serviceType as ServiceTypeSlug }),
        ...(opts.paymentMethod !== 'all' && { paymentMethod: opts.paymentMethod as PaymentMethod }),
        // Both bounds anchored to Cuba time (UTC−4/−5). Date-only strings
        // parse as midnight UTC per the ECMAScript spec while 'T23:59:59'
        // parses in the BROWSER's zone — the two ends of the same filter used
        // different timezones and "Desde 10/06" included rides from the night
        // of 09/06 in Havana.
        ...(opts.dateFrom && { dateFrom: new Date(`${opts.dateFrom}T00:00:00-04:00`).toISOString() }),
        ...(opts.dateTo && { dateTo: new Date(`${opts.dateTo}T23:59:59-04:00`).toISOString() }),
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
      // Surface the failure (parity con el ErrorState + retry del rides móvil)
      // en vez de mostrar un "sin viajes" engañoso.
      if (!append) setError(t('rides.error_loading', { defaultValue: 'No se pudieron cargar tus viajes. Revisá tu conexión e intentá de nuevo.' }));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentOpts = (): LoadOpts => ({ tab: activeTab, serviceType: serviceFilter, paymentMethod: paymentFilter, dateFrom, dateTo });

  useEffect(() => {
    if (!userId) return;
    loadRides(userId, 0, false, { tab: activeTab, serviceType: serviceFilter, paymentMethod: paymentFilter, dateFrom, dateTo });
  }, [userId, activeTab, serviceFilter, paymentFilter, dateFrom, dateTo, loadRides]);

  // Refetch when the tab regains focus (parity con el pull-to-refresh móvil) —
  // un viaje recién completado/cancelado en otra pestaña aparece al volver.
  useEffect(() => {
    if (!userId) return;
    const refresh = () => { if (!document.hidden) loadRides(userId, 0, false, { tab: activeTab, serviceType: serviceFilter, paymentMethod: paymentFilter, dateFrom, dateTo }); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [userId, activeTab, serviceFilter, paymentFilter, dateFrom, dateTo, loadRides]);

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
          <p style={{ fontSize: '0.875rem' }}>{t('rides.loading', { defaultValue: 'Cargando...' })}</p>
        </div>
      </div>
    );
  }

  const handleLoadMore = () => {
    if (loadingMore) return;
    loadRides(userId, page + 1, true, currentOpts());
  };

  const handleTabChange = (tab: TabFilter) => {
    if (tab === activeTab) return;
    setActiveTab(tab);
    setRides([]);
    setPage(0);
  };

  // Export history to CSV (parity con generateHistoryCSV + share del rides móvil).
  // En web descargamos el archivo en vez de compartirlo.
  const handleExportCsv = () => {
    if (rides.length === 0) return;
    const csv = generateHistoryCSV(rides, 'es');
    // BOM so Excel-Windows decodes the UTF-8 accents (Método, direcciones
    // cubanas) — same as the admin's exportCsv helper.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tricigo-viajes-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const dateGroups = groupRidesByDate(rides);
  let globalCardIdx = 0;

  return (
    <main className="page-main">
      <div className="page-container">
        <Link href="/" aria-label={t('rides.back_home', { defaultValue: 'Volver al inicio' })} style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>
          {t('rides.back_home_link', { defaultValue: '← Inicio' })}
        </Link>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginTop: '1rem', marginBottom: '1.25rem' }}>
          <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, margin: 0 }}>
            {t('rides.title', { defaultValue: 'Historial de viajes' })}
          </h1>
          {rides.length > 0 && (
            <button
              onClick={handleExportCsv}
              aria-label={t('rides.export_csv_aria', { defaultValue: 'Exportar historial a CSV' })}
              className="btn-base btn-secondary-outline"
              style={{ cursor: 'pointer', fontSize: '0.8rem', flexShrink: 0, padding: '0.4rem 0.8rem' }}
            >
              {t('rides.export_csv', { defaultValue: 'Exportar CSV' })}
            </button>
          )}
        </div>

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

        {/* Filtros avanzados (servicio / pago / fechas) — parity con los filtros
            del rides móvil; getRideHistoryFiltered los aplica server-side. */}
        <div style={{ marginBottom: '1rem' }}>
          <button
            type="button"
            onClick={() => setShowFilters((s) => !s)}
            style={{ background: 'none', border: 'none', color: 'var(--primary)', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', padding: '0.25rem 0' }}
          >
            {showFilters
              ? t('rides.filters_less', { defaultValue: '− Menos filtros' })
              : t('rides.filters_more', { defaultValue: '+ Más filtros' })}
            {(serviceFilter !== 'all' || paymentFilter !== 'all' || dateFrom || dateTo) ? t('rides.filters_active', { defaultValue: ' · activos' }) : ''}
          </button>
          {showFilters && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', marginTop: '0.5rem', alignItems: 'flex-end' }}>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {t('rides.filter_service', { defaultValue: 'Servicio' })}
                <select value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)} className="input-base" style={{ fontSize: '0.82rem' }}>
                  <option value="all">{t('rides.filter_all', { defaultValue: 'Todos' })}</option>
                  {SERVICE_SLUGS.map((slug) => (
                    <option key={slug} value={slug}>{SERVICE_LABELS[slug]}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {t('rides.filter_payment', { defaultValue: 'Pago' })}
                <select value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)} className="input-base" style={{ fontSize: '0.82rem' }}>
                  <option value="all">{t('rides.filter_all', { defaultValue: 'Todos' })}</option>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>{PAYMENT_LABELS[m]}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {t('rides.filter_from', { defaultValue: 'Desde' })}
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input-base" style={{ fontSize: '0.82rem' }} />
              </label>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {t('rides.filter_to', { defaultValue: 'Hasta' })}
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input-base" style={{ fontSize: '0.82rem' }} />
              </label>
              {(serviceFilter !== 'all' || paymentFilter !== 'all' || dateFrom || dateTo) && (
                <button
                  type="button"
                  onClick={() => { setServiceFilter('all'); setPaymentFilter('all'); setDateFrom(''); setDateTo(''); }}
                  style={{ background: 'none', border: '1px solid var(--border)', borderRadius: '0.5rem', padding: '0.45rem 0.7rem', fontSize: '0.78rem', color: 'var(--text-secondary)', cursor: 'pointer' }}
                >
                  {t('rides.filter_clear', { defaultValue: 'Limpiar' })}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Loading */}
        {loading && <WebSkeletonList count={4} />}

        {/* Error + retry (parity con el ErrorState del rides móvil) */}
        {!loading && error && (
          <div style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
            <p style={{ fontSize: '0.95rem', fontWeight: 600, color: '#dc2626', margin: '0 0 1rem' }}>{error}</p>
            <button
              onClick={() => loadRides(userId, 0, false, currentOpts())}
              className="btn-base btn-secondary-outline"
              style={{ cursor: 'pointer' }}
            >
              {t('rides.retry', { defaultValue: 'Reintentar' })}
            </button>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && rides.length === 0 && (
          <WebEmptyState
            icon="🚗"
            title={activeTab === 'all'
              ? t('rides.empty_all_title', { defaultValue: 'Sin viajes todavía' })
              : activeTab === 'completed'
                ? t('rides.empty_completed_title', { defaultValue: 'Sin viajes completados' })
                : t('rides.empty_canceled_title', { defaultValue: 'Sin viajes cancelados' })}
            description={activeTab === 'all'
              ? t('rides.empty_all_desc', { defaultValue: 'Cuando completes un viaje, aparecerá aquí.' })
              : t('rides.empty_filtered_desc', { defaultValue: 'No hay viajes con este filtro.' })}
            action={{ label: t('rides.request_ride', { defaultValue: 'Solicitar un viaje' }), href: '/book' }}
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
                    const statusLabel = ride.status === 'completed'
                      ? t('rides.status_completed', { defaultValue: 'Completado' })
                      : t('rides.status_canceled', { defaultValue: 'Cancelado' });
                    const serviceType = (ride as any).service_type ?? '';

                    return (
                      <div
                        key={ride.id}
                        className="ride-card"
                        role="button"
                        tabIndex={0}
                        style={{ animationDelay: `${Math.min(cardIdx * 0.05, 0.4)}s` }}
                        aria-label={t('rides.card_aria', { pickup: ride.pickup_address, dropoff: ride.dropoff_address, defaultValue: 'Ver viaje de {{pickup}} a {{dropoff}}' })}
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
                              <div className="ride-address-label">{t('rides.route_from', { defaultValue: 'Desde' })}</div>
                              <div className="ride-address">{ride.pickup_address}</div>
                            </div>
                            <div>
                              <div className="ride-address-label">{t('rides.route_to', { defaultValue: 'Hasta' })}</div>
                              <div className="ride-address">{ride.dropoff_address}</div>
                            </div>
                          </div>
                        </div>

                        {/* Footer */}
                        <div className="ride-card-footer">
                          <span className="ride-fare">
                            {(() => {
                              // Currency-aware + tip-inclusive (parity con riderChargedTotal del
                              // rides móvil): efectivo/mixto/corporativo en CUP, tricicoin en TRC.
                              // Antes mostraba TRC para todos (incl. efectivo) y omitía la propina.
                              const cup = riderChargedTotal(ride);
                              const trc = riderChargedTotalTrc(ride);
                              return ride.payment_method === 'tricicoin' ? formatTRC(trc ?? cup) : formatCUP(cup);
                            })()}
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
                aria-label={t('rides.load_more_aria', { defaultValue: 'Cargar más viajes' })}
                className="btn-base btn-secondary-outline"
                style={{ width: '100%', marginTop: '1rem' }}
              >
                {loadingMore ? <span className="spinner" style={{ width: 14, height: 14 }} /> : t('rides.load_more', { defaultValue: 'Cargar más viajes' })}
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
