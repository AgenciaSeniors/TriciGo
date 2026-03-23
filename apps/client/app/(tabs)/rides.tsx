import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, FlatList, Pressable, ActivityIndicator, RefreshControl, Alert } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api/services/ride';
import { formatTRC, generateHistoryCSV, getRelativeDay, getErrorMessage, triggerSelection, logger } from '@tricigo/utils';
import type { Ride, ServiceTypeSlug, PaymentMethod } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { RouteSummary } from '@tricigo/ui/RouteSummary';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { ErrorState } from '@tricigo/ui/ErrorState';
import { HistoryFilters } from '@tricigo/ui/HistoryFilters';
import type { HistoryFilterState } from '@tricigo/ui/HistoryFilters';
import { colors } from '@tricigo/theme';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import Toast from 'react-native-toast-message';

import { Platform, useColorScheme } from 'react-native';

const PAGE_SIZE = 20;

// Web rides: uses real data from Supabase
function WebRidesScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    async function load() {
      try {
        const data = await rideService.getRideHistory(userId!, { page: 0, pageSize: 20 });
        if (!cancelled) setRides(data);
      } catch (err) {
        logger.error('Rides fetch error', { error: String(err) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [userId]);

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <Text variant="h3" className="mb-4">{t('rides_history.title', { defaultValue: 'Historial de viajes' })}</Text>

        {loading ? (
          <ActivityIndicator size="small" color={colors.brand.orange} />
        ) : rides.length === 0 ? (
          <Text variant="body" color="secondary">{t('rides_history.no_rides', { defaultValue: 'Sin viajes' })}</Text>
        ) : (
          rides.map((ride) => (
            <Card key={ride.id} variant="outlined" padding="md" className="mb-3">
              <View className="flex-row items-center justify-between mb-2">
                <Text variant="caption" color="secondary">{getRelativeDay(ride.created_at)}</Text>
                <StatusBadge
                  label={ride.status === 'completed' ? t('rides_history.completed') : t('rides_history.canceled')}
                  variant={ride.status === 'completed' ? 'success' : 'error'}
                />
              </View>
              <RouteSummary pickupAddress={ride.pickup_address} dropoffAddress={ride.dropoff_address} compact className="mb-2" />
              <View className="flex-row justify-between items-center">
                <Text variant="body" className="font-semibold">{formatTRC(ride.final_fare_trc ?? ride.estimated_fare_trc ?? 0)}</Text>
                <Text variant="caption" color="tertiary">{ride.payment_method === 'cash' ? t('payment.cash') : 'TriciCoin'}</Text>
              </View>
            </Card>
          ))
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

  const renderItem = useCallback(({ item }: { item: Ride }) => {
    const fare = item.final_fare_trc ?? item.estimated_fare_trc ?? item.estimated_fare_cup;

    return (
      <Pressable
        onPress={() => router.push(`/ride/${item.id}`)}
        accessibilityRole="button"
        accessibilityLabel={`${getRelativeDay(item.created_at, t('common.today'), t('common.yesterday'))}, ${item.status === 'completed' ? t('rides_history.completed') : t('rides_history.canceled')}, ${item.pickup_address} → ${item.dropoff_address}, ${formatTRC(fare)}`}
      >
        <Card variant="outlined" padding="md" className="mb-3">
          <View className="flex-row items-center justify-between mb-2">
            <Text variant="caption" color="secondary">
              {getRelativeDay(item.created_at, t('common.today'), t('common.yesterday'))}
            </Text>
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
    );
  }, [t]);

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <View className="flex-row items-center justify-between mb-2">
          <Text variant="h3">{t('rides_history.title')}</Text>
          {rides.length > 0 && (
            <Pressable onPress={handleExportCSV} className="flex-row items-center gap-1 px-3 py-1.5 rounded-full bg-neutral-100" accessibilityRole="button" accessibilityLabel={t('rides_history.export_csv', { defaultValue: 'Export CSV' })}>
              <Ionicons name="download-outline" size={14} color={isDark ? '#9CA3AF' : '#6b7280'} />
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
            {scheduledRides.map((ride) => (
              <Pressable key={ride.id} onPress={() => router.push(`/ride/${ride.id}`)}>
                <Card variant="outlined" padding="md" className="mb-3 border-primary-500/30">
                  <View className="flex-row items-center mb-2">
                    <View className="w-8 h-8 rounded-full bg-primary-50 items-center justify-center mr-3">
                      <Ionicons name="calendar-outline" size={16} color={colors.brand.orange} />
                    </View>
                    <View className="flex-1">
                      <Text variant="bodySmall" color="accent" className="font-semibold">
                        {ride.scheduled_at
                          ? `${new Date(ride.scheduled_at).toLocaleDateString('es-CU', { day: 'numeric', month: 'short' })} — ${new Date(ride.scheduled_at).toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' })}`
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
          <View className="items-center py-20">
            <ActivityIndicator size="large" color={colors.brand.orange} />
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
