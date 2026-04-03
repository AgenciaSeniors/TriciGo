import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, FlatList, Pressable, RefreshControl, Alert, Image } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api/services/ride';
import { formatTRC, formatTime, generateHistoryCSV, getRelativeDay, getErrorMessage, triggerSelection, logger, formatTimestamp } from '@tricigo/utils';
import { SkeletonListItem } from '@tricigo/ui/Skeleton';
import { AnimatedCard, StaggeredList } from '@tricigo/ui/AnimatedCard';
import type { Ride, ServiceTypeSlug, PaymentMethod } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { RouteSummary } from '@tricigo/ui/RouteSummary';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { ErrorState } from '@tricigo/ui/ErrorState';
import { HistoryFilters } from '@tricigo/ui/HistoryFilters';
import type { HistoryFilterState } from '@tricigo/ui/HistoryFilters';
import { colors, darkColors } from '@tricigo/theme';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import Toast from 'react-native-toast-message';
import { vehicleSelectionImages } from '@/utils/vehicleImages';

import { Platform, useColorScheme } from 'react-native';

const PAGE_SIZE = 20;

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
  tropipay: 'TropiPay',
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
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeTab, setActiveTab] = useState<WebFilterTab>('all');
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const font = { fontFamily: 'Montserrat, system-ui, sans-serif' };

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
    <div style={{ height: 'calc(100vh - 60px)', overflowY: 'auto', background: '#fafafa', ...font }}>
      <style dangerouslySetInnerHTML={{ __html: WEB_RIDES_CSS }} />

      <div style={{ maxWidth: 560, margin: '0 auto', padding: '24px 20px' }}>
        <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, marginBottom: 20, color: '#1a1a1a' }}>
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
                  : { background: 'transparent', border: '1.5px solid #e5e5e5', color: '#666' }),
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ padding: '16px 20px', borderRadius: 12, border: '1px solid #f0f0f0', background: '#fff' }}>
                <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 8, background: '#f0f0f0' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ width: '40%', height: 14, background: '#f0f0f0', borderRadius: 4, marginBottom: 6 }} />
                    <div style={{ width: '25%', height: 10, background: '#f5f5f5', borderRadius: 4 }} />
                  </div>
                </div>
                <div style={{ width: '80%', height: 12, background: '#f5f5f5', borderRadius: 4, marginBottom: 8 }} />
                <div style={{ width: '60%', height: 12, background: '#f5f5f5', borderRadius: 4 }} />
              </div>
            ))}
          </div>
        )}

        {/* Empty */}
        {!loading && rides.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: '#999' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🚗</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#1a1a1a', marginBottom: 8 }}>
              {activeTab === 'all' ? 'Sin viajes todavía' : activeTab === 'completed' ? 'Sin viajes completados' : 'Sin viajes cancelados'}
            </div>
            <div style={{ fontSize: 14, color: '#999' }}>
              {activeTab === 'all' ? 'Cuando completes un viaje, aparecerá aquí.' : 'No hay viajes con este filtro.'}
            </div>
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
                  letterSpacing: '0.06em', color: '#999',
                  padding: '12px 0 8px', marginTop: 8,
                }}>
                  {group.label}
                </div>

                {/* Cards */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {group.rides.map((ride) => {
                    const cardIdx = globalCardIdx++;
                    const fare = ride.final_fare_trc ?? ride.estimated_fare_trc ?? 0;
                    const serviceType = ride.service_type ?? '';
                    const isCompleted = ride.status === 'completed';

                    return (
                      <div
                        key={ride.id}
                        onClick={() => router.push(`/ride/${ride.id}`)}
                        style={{
                          padding: '16px 20px', borderRadius: 12,
                          border: '1px solid #f0f0f0', background: '#fff',
                          cursor: 'pointer',
                          transition: 'box-shadow 0.2s ease, transform 0.2s ease',
                          opacity: 0,
                          animation: `wr-fadeInUp 0.4s ease ${Math.min(cardIdx * 0.05, 0.4)}s forwards`,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'translateY(0)'; }}
                      >
                        {/* Header */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                            <div style={{
                              width: 40, height: 40, borderRadius: 8,
                              background: '#f5f5f5', display: 'flex',
                              alignItems: 'center', justifyContent: 'center',
                            }}>
                              <Image
                                source={vehicleSelectionImages[serviceType as ServiceTypeSlug] ?? vehicleSelectionImages.auto_standard}
                                style={{ width: 28, height: 28 }}
                                resizeMode="contain"
                              />
                            </div>
                            <div>
                              <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1a1a', lineHeight: '1.3' }}>
                                {WEB_SERVICE_LABELS[serviceType] ?? serviceType}
                              </div>
                              <div style={{ fontSize: 12, color: '#999', marginTop: 1 }}>
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
                              backgroundImage: 'repeating-linear-gradient(to bottom, #e5e5e5 0px, #e5e5e5 3px, transparent 3px, transparent 6px)',
                            }} />
                            <div style={{
                              width: 10, height: 10, borderRadius: '50%',
                              background: '#ef4444', flexShrink: 0,
                              boxShadow: '0 0 0 3px rgba(239,68,68,0.15)',
                            }} />
                          </div>
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 12, minWidth: 0 }}>
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em', color: '#999', marginBottom: 1 }}>Desde</div>
                              <div style={{ fontSize: 13, fontWeight: 500, color: '#1a1a1a', lineHeight: '1.3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ride.pickup_address}</div>
                            </div>
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em', color: '#999', marginBottom: 1 }}>Hasta</div>
                              <div style={{ fontSize: 13, fontWeight: 500, color: '#1a1a1a', lineHeight: '1.3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ride.dropoff_address}</div>
                            </div>
                          </div>
                        </div>

                        {/* Footer */}
                        <div style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          paddingTop: 12, borderTop: '1px solid #f0f0f0',
                        }}>
                          <span style={{ fontSize: 18, fontWeight: 800, color: '#1a1a1a', letterSpacing: '-0.02em' }}>
                            {formatTRC(fare)}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#999', fontWeight: 500 }}>
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
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const userId = useAuthStore((s) => s.user?.id);

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
    { value: 'tropipay', label: t('payment.tropipay', { defaultValue: 'TropiPay' }) },
  ];

  const filterLabels = useMemo(() => ({
    filters: t('rides_history.filters', { defaultValue: 'Filtros' }),
    all: t('rides_history.all_statuses', { defaultValue: 'Todos' }),
    completed: t('rides_history.completed'),
    canceled: t('rides_history.canceled'),
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
    const fare = item.final_fare_trc ?? item.estimated_fare_trc ?? item.estimated_fare_cup;

    return (
      <AnimatedCard delay={Math.min(index * 60, 300)}>
        <Pressable
          onPress={() => router.push(`/ride/${item.id}`)}
          accessibilityRole="button"
          accessibilityLabel={`${getRelativeDay(item.created_at, t('common.today'), t('common.yesterday'))}, ${item.status === 'completed' ? t('rides_history.completed') : t('rides_history.canceled')}, ${item.pickup_address} → ${item.dropoff_address}, ${formatTRC(fare)}`}
        >
          <Card variant="outlined" padding="md" className="mb-3">
            <View className="flex-row items-center justify-between mb-2">
              <View className="flex-row items-center gap-2">
                {item.service_type && vehicleSelectionImages[item.service_type as ServiceTypeSlug] && (
                  <Image
                    source={vehicleSelectionImages[item.service_type as ServiceTypeSlug]}
                    style={{ width: 28, height: 28 }}
                    resizeMode="contain"
                  />
                )}
                <Text variant="caption" color="secondary">
                  {getRelativeDay(item.created_at, t('common.today'), t('common.yesterday'))}
                </Text>
              </View>
              <StatusBadge
                label={item.status === 'completed' ? t('rides_history.completed') : t('rides_history.canceled')}
                variant={item.status === 'completed' ? 'success' : 'error'}
              />
            </View>

            <RouteSummary
              pickupAddress={item.pickup_address}
              dropoffAddress={item.dropoff_address}
              compact
              className="mb-2"
            />

            <View className="flex-row justify-between items-center">
              <Text variant="body" className="font-semibold">{formatTRC(fare)}</Text>
              <Text variant="caption" color="tertiary">{item.payment_method === 'cash' ? t('payment.cash') : t('payment.tricicoin')}</Text>
            </View>

          </Card>
        </Pressable>
      </AnimatedCard>
    );
  }, [t]);

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <View className="flex-row items-center justify-between mb-2">
          <Text variant="h3">{t('rides_history.title')}</Text>
          {rides.length > 0 && (
            <Pressable onPress={handleExportCSV} className="flex-row items-center gap-1 px-3 py-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800" accessibilityRole="button" accessibilityLabel={t('rides_history.export_csv', { defaultValue: 'Export CSV' })}>
              <Ionicons name="download-outline" size={14} color={isDark ? darkColors.text.secondary : colors.neutral[500]} />
              <Text variant="caption" color="secondary" className="font-medium">CSV</Text>
            </Pressable>
          )}
        </View>

        <HistoryFilters
          filters={filters}
          onFilterChange={handleFilterChange}
          serviceTypes={serviceTypes}
          paymentMethods={paymentMethods}
          labels={filterLabels}
        />

        {/* Scheduled rides section */}
        {scheduledRides.length > 0 && (
          <View className="mb-6">
            <Text variant="h4" className="mb-3">
              {t('ride.scheduled_rides', { defaultValue: 'Viajes programados' })}
            </Text>
            <StaggeredList staggerDelay={60}>
              {scheduledRides.map((ride) => (
                <Pressable key={ride.id} onPress={() => router.push(`/ride/${ride.id}`)}>
                  <Card variant="outlined" padding="md" className="mb-3 border-primary-500/30">
                    <View className="flex-row items-center mb-2">
                      <View className="w-8 h-8 rounded-full bg-primary-50 dark:bg-primary-950 items-center justify-center mr-3">
                        <Ionicons name="calendar-outline" size={16} color={colors.brand.orange} />
                      </View>
                      <View className="flex-1">
                        <Text variant="bodySmall" color="accent" className="font-semibold">
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
                  </Card>
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
              <EmptyState
                icon="car-outline"
                title={t('rides_history.no_rides')}
              />
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
