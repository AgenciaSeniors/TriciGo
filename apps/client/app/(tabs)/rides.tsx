import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, FlatList, Pressable, RefreshControl, Alert, Image, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api/services/ride';
import { formatTRC, formatCUP, formatUSD, cupToUsd, DEFAULT_EXCHANGE_RATE, formatTime, generateHistoryCSV, getRelativeDay, getErrorMessage, triggerSelection, logger, formatTimestamp, riderChargedTotal, riderChargedTotalTrc } from '@tricigo/utils';
import { SkeletonListItem } from '@tricigo/ui/Skeleton';
import { AnimatedCard, StaggeredList } from '@tricigo/ui/AnimatedCard';
import type { Ride, ServiceTypeSlug, PaymentMethod } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';
import { useTokens } from '@/hooks/useTokens';
import { useThemeStore } from '@/stores/theme.store';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { RouteSummary } from '@tricigo/ui/RouteSummary';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { ErrorState } from '@tricigo/ui/ErrorState';
import { HistoryFilters } from '@tricigo/ui/HistoryFilters';
import type { HistoryFilterState } from '@tricigo/ui/HistoryFilters';
import { colors, darkColors } from '@tricigo/theme';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
// Bugfix: the new expo-file-system SDK moved legacy helpers like
// `cacheDirectory` and `EncodingType` behind /legacy. The driver app
// already uses the legacy import for the same CSV-export pattern — sync
// the client so `FileSystem.cacheDirectory` resolves at runtime instead
// of hitting a TypeError when a rider exports their ride history.
import * as FileSystem from 'expo-file-system/legacy';
import Toast from 'react-native-toast-message';
import { vehicleSelectionImages } from '@/utils/vehicleImages';

import { Platform, useColorScheme } from 'react-native';

const PAGE_SIZE = 20;

// Tabular-nums for monetary alignment (mirrors driver trips.tsx).
const TABULAR: { fontVariant: ('tabular-nums')[] } = { fontVariant: ['tabular-nums'] };

// Web rides: uses real data from Supabase
type WebFilterTab = 'all' | 'completed' | 'canceled';

const WEB_PAGE_SIZE = 20;

/* ── CSS keyframes for web rides animations ── */
const WEB_RIDES_CSS = `
  @keyframes wr-fadeInUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
`;

const WEB_SERVICE_LABELS: Record<string, string> = {
  triciclo_basico: 'Triciclo',
  triciclo_premium: 'Triciclo Premium',
  triciclo_cargo: 'Triciclo Cargo',
  moto_standard: 'Moto',
  auto_standard: 'Auto',
  auto_confort: 'Confort',
  mensajeria: 'Envío',
};

const WEB_PAYMENT_LABELS: Record<string, string> = {
  cash: 'Efectivo',
  tricicoin: 'TriciCoin',
  mixed: 'Mixto',
  corporate: 'Corporativo',
};

function webGroupRidesByDate(rides: Ride[]): { label: string; rides: Ride[] }[] {
  const groups: Map<string, Ride[]> = new Map();
  for (const ride of rides) {
    const label = getRelativeDay(ride.created_at, 'Hoy', 'Ayer');
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(ride);
  }
  return Array.from(groups.entries()).map(([label, groupRides]) => ({ label, rides: groupRides }));
}

function WebRidesScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const isDark = useThemeStore((s) => s.resolvedScheme) === 'dark';
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeTab, setActiveTab] = useState<WebFilterTab>('all');
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const font = { fontFamily: 'Montserrat, system-ui, sans-serif' };

  // Theme-aware palette — mirrors the app's cubanDark tokens. Brand orange,
  // semantic status greens/reds and skeleton greys stay fixed.
  const c = isDark
    ? {
        bg: '#0A0E1A',
        surface: '#11172A',
        elevated: '#18203A',
        text: '#F4F0EA',
        textMuted: '#B7C4CF',
        textSubtle: '#6B7F8F',
        border: 'rgba(244,240,234,0.10)',
      }
    : {
        bg: '#fafafa',
        surface: '#fff',
        elevated: '#f5f5f5',
        text: '#1a1a1a',
        textMuted: '#666',
        textSubtle: '#999',
        border: '#f0f0f0',
      };

  const fetchRides = useCallback(async (p: number, tab: WebFilterTab, append: boolean) => {
    if (!userId) return;
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      const data = await rideService.getRideHistoryFiltered({
        userId,
        page: p,
        pageSize: WEB_PAGE_SIZE,
        ...(tab !== 'all' && { status: [tab] }),
      });
      if (append) {
        setRides((prev) => [...prev, ...data]);
      } else {
        setRides(data);
      }
      setHasMore(data.length >= WEB_PAGE_SIZE);
    } catch (err) {
      logger.error('Rides fetch error', { error: String(err) });
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    setPage(0);
    fetchRides(0, activeTab, false);
  }, [userId, activeTab, fetchRides]);

  const handleLoadMore = useCallback(() => {
    const nextPage = page + 1;
    setPage(nextPage);
    fetchRides(nextPage, activeTab, true);
  }, [page, activeTab, fetchRides]);

  const filterTabs: { key: WebFilterTab; label: string }[] = useMemo(() => [
    { key: 'all', label: t('rides_history.all_statuses', { defaultValue: 'Todos' }) },
    { key: 'completed', label: t('rides_history.completed', { defaultValue: 'Completados' }) },
    { key: 'canceled', label: t('rides_history.canceled', { defaultValue: 'Cancelados' }) },
  ], [t]);

  const dateGroups = webGroupRidesByDate(rides);
  let globalCardIdx = 0;

  return (
    <div style={{ height: 'calc(100vh - 60px)', overflowY: 'auto', background: c.bg, ...font }}>
      <style dangerouslySetInnerHTML={{ __html: WEB_RIDES_CSS }} />

      <div style={{ maxWidth: 560, margin: '0 auto', padding: '24px 20px' }}>
        <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, marginBottom: 20, color: c.text }}>
          {t('rides_history.title', { defaultValue: 'Historial de viajes' })}
        </h1>

        {/* Filter tabs — identical to web */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, overflowX: 'auto' }}>
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => { if (tab.key !== activeTab) { setActiveTab(tab.key); setRides([]); setPage(0); } }}
              style={{
                display: 'inline-flex', alignItems: 'center',
                padding: '8px 18px', borderRadius: 999,
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
                whiteSpace: 'nowrap', ...font,
                transition: 'all 0.2s ease',
                ...(activeTab === tab.key
                  ? { background: '#FF4D00', borderColor: '#FF4D00', color: '#fff', border: '1.5px solid #FF4D00' }
                  : { background: 'transparent', border: `1.5px solid ${c.border}`, color: c.textMuted }),
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[0, 1, 2, 3].map((i) => {
              const skelStrong = isDark ? '#18203A' : '#f0f0f0';
              const skelSoft = isDark ? '#141B30' : '#f5f5f5';
              return (
                <div key={i} style={{ padding: '16px 20px', borderRadius: 12, border: `1px solid ${c.border}`, background: c.surface }}>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 8, background: skelStrong }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ width: '40%', height: 14, background: skelStrong, borderRadius: 4, marginBottom: 6 }} />
                      <div style={{ width: '25%', height: 10, background: skelSoft, borderRadius: 4 }} />
                    </div>
                  </div>
                  <div style={{ width: '80%', height: 12, background: skelSoft, borderRadius: 4, marginBottom: 8 }} />
                  <div style={{ width: '60%', height: 12, background: skelSoft, borderRadius: 4 }} />
                </div>
              );
            })}
          </div>
        )}

        {/* Empty — UX: split by cause so the CTA matches the situation.
             First-time users (filter = 'all') get a warm push-to-home;
             users who filtered themselves into an empty result get a
             one-click way to restore 'all'. Bare "Sin viajes todavía"
             was a dead end on day 1 and "No hay viajes con este filtro"
             didn't offer the obvious next step. */}
        {!loading && rides.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: c.textSubtle }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={isDark ? '#3A4661' : '#ccc'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 auto 16px' }}><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9L18 10l-2.7-3.6A2 2 0 0013.7 5H10l-2.7 1.4L5 10 2.5 11.1C1.7 11.3 1 12.1 1 13v3c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>
            <div style={{ fontSize: 18, fontWeight: 700, color: c.text, marginBottom: 8 }}>
              {activeTab === 'all' ? 'Sin viajes todavía' : activeTab === 'completed' ? 'Sin viajes completados' : 'Sin viajes cancelados'}
            </div>
            <div style={{ fontSize: 14, color: c.textSubtle, marginBottom: 20 }}>
              {activeTab === 'all'
                ? 'Cuando completes un viaje, aparecerá aquí con todos los detalles.'
                : 'No hay viajes con este filtro.'}
            </div>
            {activeTab === 'all' ? (
              <button
                type="button"
                onClick={() => router.push('/(tabs)')}
                style={{
                  padding: '10px 20px', borderRadius: 10, border: 'none',
                  background: colors.brand.orange, color: '#fff', fontSize: 14,
                  fontWeight: 600, cursor: 'pointer',
                }}
              >
                Pedí tu primer viaje
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { setActiveTab('all'); setRides([]); setPage(0); }}
                style={{
                  padding: '10px 20px', borderRadius: 10,
                  background: c.surface, color: colors.brand.orange, fontSize: 14,
                  fontWeight: 600, cursor: 'pointer',
                  border: '1px solid ' + colors.brand.orange,
                }}
              >
                Mostrar todos
              </button>
            )}
          </div>
        )}

        {/* Rides grouped by date — identical to web */}
        {!loading && rides.length > 0 && (
          <div>
            {dateGroups.map((group) => (
              <div key={group.label}>
                {/* Date header */}
                <div style={{
                  fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const,
                  letterSpacing: '0.06em', color: c.textSubtle,
                  padding: '12px 0 8px', marginTop: 8,
                }}>
                  {group.label}
                </div>

                {/* Cards */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {group.rides.map((ride) => {
                    const cardIdx = globalCardIdx++;
                    // BUG-293: pick the correct currency based on payment
                    // method. Previously fell back to TRC fields and showed
                    // "0 TRC" for cash rides where only *_fare_cup is set.
                    const rShowTrc = ride.payment_method === 'tricicoin';
                    // BUG-fare-display-parity: incluir tip en "Total cobrado".
                    // El RPC no suma tip al final_fare_cup pero el wallet sí
                    // debita final + tip. Sin esto, la lista muestra menos
                    // de lo que el rider pagó cuando hay propina.
                    const rTrc = riderChargedTotalTrc(ride);
                    const rCup = riderChargedTotal(ride);
                    const fareLabel =
                      rShowTrc && rTrc != null
                        ? formatTRC(rTrc)
                        : formatCUP(rCup ?? 0);
                    const serviceType = ride.service_type ?? '';
                    const isCompleted = ride.status === 'completed';

                    return (
                      <div
                        key={ride.id}
                        onClick={() => router.push(`/ride/${ride.id}`)}
                        style={{
                          padding: '16px 20px', borderRadius: 12,
                          border: `1px solid ${c.border}`, background: c.surface,
                          cursor: 'pointer',
                          transition: 'box-shadow 0.2s ease, transform 0.2s ease',
                          opacity: 0,
                          animation: `wr-fadeInUp 0.4s ease ${Math.min(cardIdx * 0.05, 0.4)}s forwards`,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.boxShadow = isDark ? '0 4px 12px rgba(0,0,0,0.4)' : '0 4px 12px rgba(0,0,0,0.08)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'translateY(0)'; }}
                      >
                        {/* Header */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                            <div style={{
                              width: 40, height: 40, borderRadius: 8,
                              background: c.elevated, display: 'flex',
                              alignItems: 'center', justifyContent: 'center',
                            }}>
                              <Image
                                source={vehicleSelectionImages[serviceType as ServiceTypeSlug] ?? vehicleSelectionImages.auto_standard}
                                style={{ width: 28, height: 28 }}
                                resizeMode="contain"
                              />
                            </div>
                            <div>
                              <div style={{ fontSize: 14, fontWeight: 600, color: c.text, lineHeight: '1.3' }}>
                                {WEB_SERVICE_LABELS[serviceType] ?? serviceType}
                              </div>
                              <div style={{ fontSize: 12, color: c.textSubtle, marginTop: 1 }}>
                                {formatTime(ride.created_at)}
                              </div>
                            </div>
                          </div>
                          {/* Status badge */}
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 5,
                            padding: '4px 10px', borderRadius: 999,
                            fontSize: 11, fontWeight: 700,
                            textTransform: 'uppercase' as const, letterSpacing: '0.03em',
                            background: isCompleted ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                            color: isCompleted ? '#22c55e' : '#ef4444',
                          }}>
                            <span style={{
                              width: 6, height: 6, borderRadius: '50%',
                              background: 'currentColor', flexShrink: 0,
                            }} />
                            {isCompleted ? 'Completado' : 'Cancelado'}
                          </span>
                        </div>

                        {/* Route */}
                        <div style={{ display: 'flex', gap: 12, marginBottom: 12, paddingLeft: 4 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 12, paddingTop: 4 }}>
                            <div style={{
                              width: 10, height: 10, borderRadius: '50%',
                              background: '#22c55e', flexShrink: 0,
                              boxShadow: '0 0 0 3px rgba(34,197,94,0.15)',
                            }} />
                            <div style={{
                              width: 2, flex: 1, minHeight: 24, borderRadius: 1,
                              backgroundImage: `repeating-linear-gradient(to bottom, ${c.border} 0px, ${c.border} 3px, transparent 3px, transparent 6px)`,
                            }} />
                            <div style={{
                              width: 10, height: 10, borderRadius: '50%',
                              background: '#ef4444', flexShrink: 0,
                              boxShadow: '0 0 0 3px rgba(239,68,68,0.15)',
                            }} />
                          </div>
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 12, minWidth: 0 }}>
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em', color: c.textSubtle, marginBottom: 1 }}>Desde</div>
                              <div style={{ fontSize: 13, fontWeight: 500, color: c.text, lineHeight: '1.3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ride.pickup_address}</div>
                            </div>
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em', color: c.textSubtle, marginBottom: 1 }}>Hasta</div>
                              <div style={{ fontSize: 13, fontWeight: 500, color: c.text, lineHeight: '1.3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ride.dropoff_address}</div>
                            </div>
                          </div>
                        </div>

                        {/* Footer */}
                        <div style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          paddingTop: 12, borderTop: `1px solid ${c.border}`,
                        }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontSize: 18, fontWeight: 800, color: c.text, letterSpacing: '-0.02em' }}>
                              {fareLabel}
                            </span>
                            {(ride.tip_amount ?? 0) > 0 && (
                              <span style={{ fontSize: 11, fontWeight: 600, color: '#16a34a', marginTop: 2 }}>
                                {t('ride.tip_included', { defaultValue: 'Propina incluida' })} +{rShowTrc && rTrc != null ? formatTRC(ride.tip_amount ?? 0) : formatCUP(ride.tip_amount ?? 0)}
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: c.textSubtle, fontWeight: 500 }}>
                            {ride.estimated_distance_m != null && ride.estimated_distance_m > 0 && (
                              <span>{(ride.estimated_distance_m / 1000).toFixed(1)} km ·</span>
                            )}
                            <span>{WEB_PAYMENT_LABELS[ride.payment_method] ?? ride.payment_method}</span>
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
                style={{
                  width: '100%', marginTop: 16, padding: '12px 24px',
                  borderRadius: 12, border: '1.5px solid #FF4D00',
                  background: 'transparent', color: '#FF4D00',
                  fontWeight: 600, fontSize: 14, cursor: 'pointer',
                  ...font, transition: 'all 0.2s ease',
                  opacity: loadingMore ? 0.5 : 1,
                }}
              >
                {loadingMore ? 'Cargando...' : t('rides_history.load_more', { defaultValue: 'Cargar más viajes' })}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NativeRidesScreen() {
  const { t } = useTranslation('rider');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const tokens = useTokens();
  const userId = useAuthStore((s) => s.user?.id);

  // Dynamic card shadow (mirrors driver trips.tsx): stronger in dark, soft in light.
  const CARD_SHADOW = {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.4 : 0.06,
    shadowRadius: 8,
    elevation: 2,
  };

  const [rides, setRides] = useState<Ride[]>([]);
  const [scheduledRides, setScheduledRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState<HistoryFilterState>({});

  const serviceTypes = [
    { value: 'triciclo_basico', label: t('service_types.triciclo_basico', { defaultValue: 'Triciclo Básico' }) },
    { value: 'triciclo_premium', label: t('service_types.triciclo_premium', { defaultValue: 'Triciclo Premium' }) },
    { value: 'moto_standard', label: t('service_types.moto_standard', { defaultValue: 'Moto' }) },
    { value: 'auto_standard', label: t('service_types.auto_standard', { defaultValue: 'Auto' }) },
    { value: 'mensajeria', label: t('service_types.mensajeria', { defaultValue: 'Mensajería' }) },
  ];

  const paymentMethods = [
    { value: 'cash', label: t('payment.cash', { defaultValue: 'Efectivo' }) },
    { value: 'tricicoin', label: t('payment.tricicoin', { defaultValue: 'TriciCoin' }) },
  ];

  const filterLabels = useMemo(() => ({
    filters: t('rides_history.filters', { defaultValue: 'Filtros' }),
    all: t('rides_history.all_statuses', { defaultValue: 'Todos' }),
    completed: t('rides_history.completed', { defaultValue: 'Completado' }),
    canceled: t('rides_history.canceled', { defaultValue: 'Cancelado' }),
    serviceType: t('rides_history.service_type', { defaultValue: 'Tipo de servicio' }),
    paymentMethod: t('rides_history.payment_method', { defaultValue: 'Método de pago' }),
    clearFilters: t('rides_history.clear_filters', { defaultValue: 'Limpiar filtros' }),
  }), [t]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoading(true);

    async function fetchRides() {
      try {
        const data = await rideService.getRideHistoryFiltered({
          userId: userId!,
          page,
          pageSize: PAGE_SIZE,
          status: filters.status,
          serviceType: filters.serviceType as ServiceTypeSlug | undefined,
          paymentMethod: filters.paymentMethod as PaymentMethod | undefined,
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
        });
        if (!cancelled) {
          // Separate scheduled (future) rides from history
          const now = new Date();
          const scheduled = data.filter(
            (r: Ride) => r.is_scheduled && r.scheduled_at && new Date(r.scheduled_at) > now && r.status === 'searching',
          );
          const history = data.filter(
            (r: Ride) => !(r.is_scheduled && r.scheduled_at && new Date(r.scheduled_at) > now && r.status === 'searching'),
          );
          if (page === 0) {
            setScheduledRides(scheduled);
            setRides(history);
          } else {
            setScheduledRides((prev) => [...prev, ...scheduled]);
            setRides((prev) => [...prev, ...history]);
          }
        }
      } catch (err) {
        logger.error('Error fetching rides', { error: String(err) });
        if (!cancelled) setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchRides();
    return () => { cancelled = true; };
  }, [userId, page, filters]);

  const handleFilterChange = useCallback((newFilters: HistoryFilterState) => {
    triggerSelection();
    setFilters(newFilters);
    setPage(0);
  }, []);

  const handleExportCSV = useCallback(async () => {
    if (rides.length === 0) return;
    const cacheDir = FileSystem.cacheDirectory;
    if (!cacheDir) {
      Toast.show({ type: 'error', text1: t('errors.export_unavailable', { defaultValue: 'Exportación no disponible' }) });
      return;
    }
    try {
      const csv = generateHistoryCSV(rides, 'es');
      const fileUri = cacheDir + 'historial_viajes.csv';
      await FileSystem.writeAsStringAsync(fileUri, csv, { encoding: FileSystem.EncodingType.UTF8 });
      await Sharing.shareAsync(fileUri, { mimeType: 'text/csv', dialogTitle: 'Exportar historial' });
    } catch (err) {
      logger.error('Error exporting CSV', { error: String(err) });
    }
  }, [rides, t]);

  const loadMore = useCallback(() => {
    if (rides.length >= (page + 1) * PAGE_SIZE) {
      setPage((p) => p + 1);
    }
  }, [rides.length, page]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setPage(0);
    try {
      if (!userId) return;
      const data = await rideService.getRideHistoryFiltered({
        userId,
        page: 0,
        pageSize: PAGE_SIZE,
        status: filters.status,
        serviceType: filters.serviceType as ServiceTypeSlug | undefined,
        paymentMethod: filters.paymentMethod as PaymentMethod | undefined,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      });
      const now = new Date();
      const scheduled = data.filter(
        (r: Ride) => r.is_scheduled && r.scheduled_at && new Date(r.scheduled_at) > now && r.status === 'searching',
      );
      const history = data.filter(
        (r: Ride) => !(r.is_scheduled && r.scheduled_at && new Date(r.scheduled_at) > now && r.status === 'searching'),
      );
      setScheduledRides(scheduled);
      setRides(history);
    } catch (err) {
      logger.error('Error refreshing rides', { error: String(err) });
      setError(getErrorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }, [userId, filters]);

  const renderItem = useCallback(({ item, index }: { item: Ride; index: number }) => {
    // BUG-293: pick the right currency based on payment_method.
    // Previously formatted all rides as TRC, even cash ones whose only
    // populated field is estimated_fare_cup.
    const showTrc = item.payment_method === 'tricicoin';
    // BUG-fare-display-parity: incluir tip en "Total cobrado". El RPC no
    // suma tip al final_fare_cup pero el wallet sí debita final + tip.
    const iTrc = riderChargedTotalTrc(item);
    const iCup = riderChargedTotal(item);
    const fareLabel =
      showTrc && iTrc != null
        ? formatTRC(iTrc)
        : formatCUP(iCup ?? 0);
    // BUG-fare-trc-usd: SIEMPRE convertir CUP→USD (no TRC→USD). Desde
    // Wallet v2 (~2026-04-08) `rides.final_fare_trc` está en USD-cents,
    // no en CUP-pegged → dividirlo por la rate daba ~5.5× chico. La
    // helper `riderChargedTotal(item)` ya retorna CUP (incluye tip).
    const rate = item.exchange_rate_usd_cup ?? DEFAULT_EXCHANGE_RATE;
    const fareUsd = cupToUsd(iCup ?? 0, rate);
    const isCompleted = item.status === 'completed';
    const statusColor = isCompleted ? '#22C55E' : '#EF4444';
    const statusDarker = isCompleted ? '#16A34A' : '#DC2626';

    return (
      <AnimatedCard delay={Math.min(index * 60, 300)}>
        <Pressable
          onPress={() => router.push(`/ride/${item.id}`)}
          accessibilityRole="button"
          accessibilityLabel={`${getRelativeDay(item.created_at, t('common.today'), t('common.yesterday'))}, ${isCompleted ? t('rides_history.completed') : t('rides_history.canceled')}, ${item.pickup_address} → ${item.dropoff_address}, ${fareLabel}`}
          style={({ pressed }) => [
            {
              backgroundColor: tokens.bg.elev1,
              borderRadius: 16,
              marginBottom: 12,
              ...CARD_SHADOW,
            },
            pressed && { opacity: 0.92, transform: [{ scale: 0.99 }] },
          ]}
        >
          {/* Date + status pill */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 14,
              paddingTop: 14,
              paddingBottom: 10,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
              {item.service_type && vehicleSelectionImages[item.service_type as ServiceTypeSlug] && (
                <Image
                  source={vehicleSelectionImages[item.service_type as ServiceTypeSlug]}
                  style={{ width: 28, height: 28, marginRight: 8 }}
                  resizeMode="contain"
                />
              )}
              <Text style={{ color: tokens.ink.secondary, fontSize: 12, fontWeight: '600' }}>
                {getRelativeDay(item.created_at, t('common.today'), t('common.yesterday'))}
              </Text>
            </View>
            <View
              style={{
                backgroundColor: `${statusColor}22`,
                borderRadius: 9999,
                paddingHorizontal: 10,
                paddingVertical: 3,
              }}
            >
              <Text
                style={{
                  color: statusDarker,
                  fontSize: 10,
                  fontWeight: '800',
                  textTransform: 'uppercase',
                  letterSpacing: 0.6,
                }}
              >
                {isCompleted ? t('rides_history.completed') : t('rides_history.canceled')}
              </Text>
            </View>
          </View>

          {/* Pickup -> dropoff */}
          <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingBottom: 12 }}>
            <View style={{ width: 12, alignItems: 'center', paddingTop: 5 }}>
              <View style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: '#22C55E' }} />
              <View
                style={{ width: 2, flex: 1, backgroundColor: tokens.line, marginVertical: 3, minHeight: 16 }}
              />
              <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: colors.brand.orange }} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ color: tokens.ink.primary, fontSize: 14, fontWeight: '500' }} numberOfLines={1}>
                {item.pickup_address}
              </Text>
              <View style={{ height: 14 }} />
              <Text style={{ color: tokens.ink.primary, fontSize: 14, fontWeight: '500' }} numberOfLines={1}>
                {item.dropoff_address}
              </Text>
            </View>
          </View>

          {/* Fare + payment */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              paddingHorizontal: 14,
              paddingTop: 12,
              paddingBottom: 14,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: tokens.line,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  color: tokens.ink.primary,
                  fontFamily: 'Montserrat_800ExtraBold',
                  fontSize: 20,
                  letterSpacing: -0.5,
                  ...TABULAR,
                }}
              >
                {fareLabel}
              </Text>
              <Text style={{ color: tokens.ink.subtle, fontSize: 11, marginTop: 3, ...TABULAR }}>
                {'\u2248'} {formatUSD(fareUsd)}
              </Text>
              {(item.tip_amount ?? 0) > 0 && (
                <Text style={{ color: '#16A34A', fontSize: 11, fontWeight: '600', marginTop: 2, ...TABULAR }}>
                  {t('ride.tip_included', { defaultValue: 'Propina incluida' })} +{showTrc && iTrc != null ? formatTRC(item.tip_amount ?? 0) : formatCUP(item.tip_amount ?? 0)}
                </Text>
              )}
            </View>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: tokens.bg.elev2,
                borderRadius: 9999,
                paddingHorizontal: 8,
                paddingVertical: 3,
              }}
            >
              <Ionicons
                name={item.payment_method === 'cash' ? 'cash-outline' : 'wallet-outline'}
                size={11}
                color={tokens.ink.secondary}
                style={{ marginRight: 4 }}
              />
              <Text style={{ color: tokens.ink.secondary, fontSize: 11, fontWeight: '600' }}>
                {item.payment_method === 'cash' ? t('payment.cash') : t('payment.tricicoin')}
              </Text>
            </View>
          </View>
        </Pressable>
      </AnimatedCard>
    );
  }, [t, tokens, isDark, CARD_SHADOW]);

  return (
    <Screen bg="cuban" padded>
      <View
        className="pt-4 flex-1"
        style={{ backgroundColor: tokens.bg.paper }}
      >
        <View className="flex-row items-center justify-between mb-4">
          <Text style={{ color: tokens.ink.primary, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 }}>
            {t('rides_history.title')}
          </Text>
          {rides.length > 0 && (
            <Pressable
              onPress={handleExportCSV}
              style={({ pressed }) => [
                {
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  backgroundColor: tokens.bg.elev2,
                  alignItems: 'center',
                  justifyContent: 'center',
                },
                pressed && { transform: [{ scale: 0.94 }] },
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('rides_history.export_csv', { defaultValue: 'Export CSV' })}
            >
              <Ionicons name="download-outline" size={18} color={tokens.ink.secondary} />
            </Pressable>
          )}
        </View>

        <HistoryFilters
          filters={filters}
          onFilterChange={handleFilterChange}
          serviceTypes={serviceTypes}
          paymentMethods={paymentMethods}
          labels={filterLabels}
          dark={isDark}
        />

        {/* Scheduled rides section — Cuban Modern card with orange accent */}
        {scheduledRides.length > 0 && (
          <View className="mb-6">
            <Text
              variant="captionMono"
              style={{ color: tokens.ink.subtle, marginBottom: 8 }}
            >
              {t('ride.scheduled_rides_label', { defaultValue: 'VIAJES PROGRAMADOS' })}
            </Text>
            <StaggeredList staggerDelay={60}>
              {scheduledRides.map((ride) => (
                <Pressable key={ride.id} onPress={() => router.push(`/ride/${ride.id}`)}>
                  <View
                    style={{
                      backgroundColor: tokens.bg.elev1,
                      borderColor: tokens.accent.orange,
                      borderWidth: 1,
                      borderRadius: 16,
                      padding: 16,
                      marginBottom: 12,
                      // subtle orange glow on light, none in dark
                      ...(isDark ? {} : {
                        shadowColor: tokens.accent.orange,
                        shadowOpacity: 0.08,
                        shadowRadius: 12,
                        shadowOffset: { width: 0, height: 2 },
                        elevation: 1,
                      }),
                    }}
                  >
                    <View className="flex-row items-center mb-2">
                      <View
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 999,
                          backgroundColor: tokens.accent.orangeGlow,
                          alignItems: 'center',
                          justifyContent: 'center',
                          marginRight: 12,
                        }}
                      >
                        <Ionicons name="calendar-outline" size={16} color={tokens.accent.orange} />
                      </View>
                      <View className="flex-1">
                        <Text
                          variant="bodySmall"
                          style={{ color: tokens.accent.orange, fontWeight: '600' }}
                        >
                          {ride.scheduled_at
                            ? formatTimestamp(ride.scheduled_at, 'absolute')
                            : ''}
                        </Text>
                      </View>
                      <StatusBadge label={t('ride.scheduled_for', { defaultValue: 'Programado' })} variant="warning" />
                    </View>
                    <RouteSummary
                      pickupAddress={ride.pickup_address}
                      dropoffAddress={ride.dropoff_address}
                      compact
                    />
                  </View>
                </Pressable>
              ))}
            </StaggeredList>
          </View>
        )}

        {error && !loading ? (
          <ErrorState
            title={t('rides_history.error_title', { defaultValue: 'Error al cargar viajes' })}
            description={error}
            onRetry={() => {
              setError(null);
              setPage(0);
            }}
            retryLabel={t('common.retry', { defaultValue: 'Reintentar' })}
          />
        ) : loading && page === 0 ? (
          <View className="py-4">
            <SkeletonListItem />
            <SkeletonListItem />
            <SkeletonListItem />
            <SkeletonListItem />
          </View>
        ) : (
          <FlatList
            data={rides}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                colors={[colors.brand.orange]}
                tintColor={colors.brand.orange}
              />
            }
            ListEmptyComponent={
              /* UX: mirror the web split. Truly-empty (no filters applied)
                 gets a warm push-to-home CTA; filtered-empty gets a one-tap
                 "limpiar filtros". Same pattern shipped in the driver
                 trips.tsx Round 8 empty state. */
              Object.values(filters).some((v) => v !== undefined && v !== null && v !== '') ? (
                <EmptyState
                  icon="filter-outline"
                  title={t('rides_history.no_results_title', { defaultValue: 'Sin resultados' })}
                  description={t('rides_history.no_results_description', { defaultValue: 'No hay viajes que coincidan con los filtros seleccionados.' })}
                  action={{
                    label: t('rides_history.clear_filters', { defaultValue: 'Limpiar filtros' }),
                    onPress: () => { setFilters({}); setPage(0); },
                  }}
                />
              ) : (
                <EmptyState
                  icon="car-outline"
                  title={t('rides_history.no_rides_title', { defaultValue: 'Aún no has hecho viajes' })}
                  description={t('rides_history.no_rides_description', { defaultValue: 'Cuando completes tu primer viaje aparecerá aquí con todos los detalles.' })}
                  action={{
                    label: t('rides_history.request_cta', { defaultValue: 'Pedí tu primer viaje' }),
                    onPress: () => router.push('/(tabs)'),
                  }}
                />
              )
            }
            ListFooterComponent={
              rides.length >= (page + 1) * PAGE_SIZE ? (
                <Button
                  title={t('rides_history.load_more')}
                  variant="outline"
                  size="sm"
                  onPress={loadMore}
                  loading={loading && page > 0}
                  className="mb-6"
                />
              ) : null
            }
          />
        )}
      </View>
    </Screen>
  );
}

export default function RidesScreen() {
  if (Platform.OS === 'web') return <WebRidesScreen />;
  return <NativeRidesScreen />;
}
