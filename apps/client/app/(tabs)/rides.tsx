import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, FlatList, Pressable, RefreshControl, Alert, Image } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api/services/ride';
import { formatTRC, generateHistoryCSV, getRelativeDay, getErrorMessage, triggerSelection, logger, formatTimestamp } from '@tricigo/utils';
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

function WebRidesScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeTab, setActiveTab] = useState<WebFilterTab>('all');
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const fetchRides = useCallback(async (p: number, tab: WebFilterTab, append: boolean) => {
    if (!userId) return;
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      const statusFilter = tab === 'all' ? undefined : tab;
      const data = await rideService.getRideHistoryFiltered({
        userId,
        page: p,
        pageSize: WEB_PAGE_SIZE,
        status: statusFilter,
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

  const getPaymentLabel = useCallback((method: string) => {
    switch (method) {
      case 'cash': return t('payment.cash', { defaultValue: 'Efectivo' });
      case 'tropipay': return 'TropiPay';
      default: return 'TriciCoin';
    }
  }, [t]);

  const getVehicleIcon = useCallback((serviceType: string): keyof typeof Ionicons.glyphMap => {
    if (serviceType.startsWith('triciclo')) return 'bicycle-outline';
    if (serviceType.startsWith('moto')) return 'speedometer-outline';
    if (serviceType === 'mensajeria') return 'cube-outline';
    return 'car-outline';
  }, []);

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <Text variant="h3" className="mb-4">
          {t('rides_history.title', { defaultValue: 'Historial de viajes' })}
        </Text>

        {/* Filter tabs */}
        <View className="flex-row gap-2 mb-5">
          {filterTabs.map((tab) => (
            <Pressable
              key={tab.key}
              onPress={() => setActiveTab(tab.key)}
              className={`px-4 py-2 rounded-full ${
                activeTab === tab.key
                  ? 'bg-primary-500'
                  : 'bg-neutral-100'
              }`}
            >
              <Text
                variant="bodySmall"
                className={`font-medium ${
                  activeTab === tab.key ? 'text-white' : 'text-neutral-600'
                }`}
              >
                {tab.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Loading state */}
        {loading ? (
          <View>
            <SkeletonListItem />
            <SkeletonListItem />
            <SkeletonListItem />
            <SkeletonListItem />
          </View>
        ) : rides.length === 0 ? (
          /* Empty state */
          <EmptyState
            icon="car-outline"
            title={t('rides_history.no_rides', { defaultValue: 'Sin viajes' })}
            description={t('rides_history.no_rides_desc', { defaultValue: 'Tu historial de viajes aparecerá aquí.' })}
          />
        ) : (
          <View>
            {/* Ride cards */}
            {rides.map((ride) => {
              const fare = ride.final_fare_trc ?? ride.estimated_fare_trc ?? 0;
              return (
                <Pressable
                  key={ride.id}
                  onPress={() => router.push(`/ride/${ride.id}`)}
                  accessibilityRole="button"
                >
                  <Card variant="outlined" padding="md" className="mb-3">
                    {/* Header: icon + date + status badge */}
                    <View className="flex-row items-center justify-between mb-3">
                      <View className="flex-row items-center gap-2">
                        <View className="w-8 h-8 rounded-full bg-neutral-100 items-center justify-center">
                          <Ionicons
                            name={getVehicleIcon(ride.service_type)}
                            size={16}
                            color={colors.neutral[500]}
                          />
                        </View>
                        <Text variant="bodySmall" color="secondary">
                          {getRelativeDay(ride.created_at)}
                        </Text>
                      </View>
                      <StatusBadge
                        label={
                          ride.status === 'completed'
                            ? t('rides_history.completed', { defaultValue: 'Completado' })
                            : t('rides_history.canceled', { defaultValue: 'Cancelado' })
                        }
                        variant={ride.status === 'completed' ? 'success' : 'error'}
                      />
                    </View>

                    {/* Body: Route visualization */}
                    <View className="flex-row mb-3 ml-1">
                      {/* Dots + dashed line column */}
                      <View className="items-center mr-3" style={{ width: 12 }}>
                        {/* Green pickup dot */}
                        <View className="w-2 h-2 rounded-full bg-green-500" />
                        {/* Dashed vertical line */}
                        <View
                          className="bg-neutral-300"
                          style={{ width: 2, height: 28, borderStyle: 'dashed' }}
                        />
                        {/* Red dropoff dot */}
                        <View className="w-2 h-2 rounded-full bg-red-500" />
                      </View>
                      {/* Address labels */}
                      <View className="flex-1 justify-between" style={{ minHeight: 44 }}>
                        <Text variant="bodySmall" numberOfLines={1}>
                          {ride.pickup_address}
                        </Text>
                        <Text variant="bodySmall" color="secondary" numberOfLines={1}>
                          {ride.dropoff_address}
                        </Text>
                      </View>
                    </View>

                    {/* Footer: fare + payment method */}
                    <View className="flex-row justify-between items-center pt-2 border-t border-neutral-100">
                      <Text variant="body" className="font-bold text-lg">
                        {formatTRC(fare)}
                      </Text>
                      <Text variant="caption" color="tertiary">
                        {getPaymentLabel(ride.payment_method)}
                      </Text>
                    </View>
                  </Card>
                </Pressable>
              );
            })}

            {/* Pagination: Load more */}
            {hasMore && (
              <View className="items-center mb-6">
                <Button
                  title={t('rides_history.load_more', { defaultValue: 'Cargar más' })}
                  variant="outline"
                  size="sm"
                  onPress={handleLoadMore}
                  loading={loadingMore}
                />
              </View>
            )}
          </View>
        )}
      </View>
    </Screen>
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
