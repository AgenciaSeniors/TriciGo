import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, FlatList, Pressable, RefreshControl, Alert, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { driverService } from '@tricigo/api/services/driver';
import { formatTRC, formatUSD, trcToUsd, DEFAULT_EXCHANGE_RATE, generateHistoryCSV, getRelativeDay } from '@tricigo/utils';
import type { Ride } from '@tricigo/types';
import { colors } from '@tricigo/theme';
import { SkeletonListItem } from '@tricigo/ui/Skeleton';
import { useDriverStore } from '@/stores/driver.store';
import { HistoryFilters } from '@tricigo/ui/HistoryFilters';
import type { HistoryFilterState } from '@tricigo/ui/HistoryFilters';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { ErrorState } from '@tricigo/ui/ErrorState';
import { Ionicons } from '@expo/vector-icons';
import { Platform } from 'react-native';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';

const PAGE_SIZE = 20;

// TEMP: Static web version for Play Store screenshots (all inline styles to bypass NativeWind web issues)
function WebTripsScreen() {
  const font = { fontFamily: 'Montserrat, system-ui, sans-serif' };
  const mockTrips = [
    { id: '1', date: 'Hoy', status: 'completed', pickup: 'Calle Obispo 101, Habana Vieja', dropoff: 'Vedado, Calle 23 y 12', fare: 'T$ 85.00', payment: 'TriciCoin' },
    { id: '2', date: 'Hoy', status: 'completed', pickup: 'Plaza de la Revolución', dropoff: 'Miramar, 5ta Ave y 42', fare: 'T$ 150.00', payment: 'Efectivo' },
    { id: '3', date: 'Ayer', status: 'completed', pickup: 'Centro Habana, Galiano', dropoff: 'Cerro, Calzada del Cerro', fare: 'T$ 60.00', payment: 'TriciCoin' },
    { id: '4', date: 'Ayer', status: 'canceled', pickup: 'Regla, Embarcadero', dropoff: 'Habana Vieja, Capitolio', fare: 'T$ 95.00', payment: 'Efectivo' },
    { id: '5', date: '12 mar', status: 'completed', pickup: 'Playa, 3ra y 70', dropoff: 'Nuevo Vedado, 26 y Boyeros', fare: 'T$ 110.00', payment: 'TriciCoin' },
  ];
  return (
    <View style={{ flex: 1, backgroundColor: '#111111' }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
        <View style={{ paddingTop: 16 }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <Text style={{ fontSize: 24, fontWeight: '700', color: '#fff', ...font }}>Historial de viajes</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: '#262626' }}>
              <Ionicons name="download-outline" size={14} color="#9ca3af" />
              <Text style={{ fontSize: 12, color: '#9ca3af', fontWeight: '500', ...font }}>CSV</Text>
            </View>
          </View>

          {/* Filter tabs */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
            {['Todos', 'Completados', 'Cancelados'].map((f, i) => (
              <View key={i} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: i === 0 ? '#F97316' : '#262626' }}>
                <Text style={{ fontSize: 12, color: i === 0 ? '#fff' : '#9ca3af', fontWeight: i === 0 ? '600' : '500', ...font }}>{f}</Text>
              </View>
            ))}
          </View>

          {/* Trip cards */}
          {mockTrips.map((trip) => (
            <View key={trip.id} style={{ backgroundColor: '#1f1f1f', borderRadius: 12, padding: 16, marginBottom: 12 }}>
              {/* Date + status badge */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <Text style={{ fontSize: 12, color: '#9ca3af', ...font }}>{trip.date}</Text>
                <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, backgroundColor: trip.status === 'completed' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)' }}>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: trip.status === 'completed' ? '#4ade80' : '#f87171', ...font }}>
                    {trip.status === 'completed' ? 'Completado' : 'Cancelado'}
                  </Text>
                </View>
              </View>
              {/* Origin + Destination */}
              <View style={{ marginBottom: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 }}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#22c55e', marginTop: 4, marginRight: 8 }} />
                  <Text style={{ fontSize: 14, color: '#fff', flex: 1, ...font }} numberOfLines={1}>{trip.pickup}</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#F97316', marginTop: 4, marginRight: 8 }} />
                  <Text style={{ fontSize: 14, color: '#d1d5db', flex: 1, ...font }} numberOfLines={1}>{trip.dropoff}</Text>
                </View>
              </View>
              {/* Fare + payment */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontSize: 16, fontWeight: '600', color: '#fff', ...font }}>{trip.fare}</Text>
                <Text style={{ fontSize: 12, color: '#6b7280', ...font }}>{trip.payment}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function NativeTripsScreen() {
  const { t } = useTranslation('driver');
  const driverProfileId = useDriverStore((s) => s.profile?.id);

  const [trips, setTrips] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [filters, setFilters] = useState<HistoryFilterState>({});

  const serviceTypes = [
    { value: 'triciclo_basico', label: t('onboarding.triciclo', { defaultValue: 'Triciclo' }) },
    { value: 'moto_standard', label: t('onboarding.moto', { defaultValue: 'Moto' }) },
    { value: 'auto_standard', label: t('onboarding.auto', { defaultValue: 'Auto' }) },
  ];

  const paymentMethods = [
    { value: 'cash', label: t('common.cash', { defaultValue: 'Efectivo' }) },
    { value: 'tricicoin', label: t('trip.tricicoin', { defaultValue: 'TriciCoin' }) },
  ];

  const filterLabels = useMemo(() => ({
    filters: t('trips_history.filters', { defaultValue: 'Filtros' }),
    all: t('trips_history.all_statuses', { defaultValue: 'Todos' }),
    completed: t('trips_history.completed', { defaultValue: 'Completado' }),
    canceled: t('trips_history.canceled', { defaultValue: 'Cancelado' }),
    serviceType: t('trips_history.service_type', { defaultValue: 'Tipo de servicio' }),
    paymentMethod: t('trips_history.payment_method', { defaultValue: 'Método de pago' }),
    clearFilters: t('trips_history.clear_filters', { defaultValue: 'Limpiar filtros' }),
  }), [t]);

  useEffect(() => {
    if (!driverProfileId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);

    async function fetchTrips() {
      try {
        const data = await driverService.getTripHistoryFiltered({
          driverId: driverProfileId!,
          page,
          pageSize: PAGE_SIZE,
          status: filters.status,
          serviceType: filters.serviceType as any,
          paymentMethod: filters.paymentMethod as any,
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
        });
        if (!cancelled) {
          setTrips((prev) => (page === 0 ? data : [...prev, ...data]));
        }
      } catch (err) {
        console.error('Error fetching trips:', err);
        if (!cancelled) setError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchTrips();
    return () => { cancelled = true; };
  }, [driverProfileId, page, filters]);

  const handleFilterChange = useCallback((newFilters: HistoryFilterState) => {
    setFilters(newFilters);
    setPage(0);
  }, []);

  const handleExportCSV = useCallback(async () => {
    if (trips.length === 0) return;
    try {
      const csv = generateHistoryCSV(trips, 'es');
      const cacheDir = FileSystem.cacheDirectory;
      if (!cacheDir) { Alert.alert('Error', 'No se puede acceder al almacenamiento'); return; }
      const fileUri = cacheDir + 'historial_viajes.csv';
      await FileSystem.writeAsStringAsync(fileUri, csv, { encoding: FileSystem.EncodingType.UTF8 });
      await Sharing.shareAsync(fileUri, { mimeType: 'text/csv', dialogTitle: 'Exportar historial' });
    } catch (err) {
      console.error('Error exporting CSV:', err);
      Alert.alert(
        t('common:errors.title', { defaultValue: 'Error' }),
        t('trips.export_failed', { defaultValue: 'No se pudo exportar el CSV' }),
      );
    }
  }, [trips]);

  const loadMore = useCallback(() => {
    if (trips.length >= (page + 1) * PAGE_SIZE) {
      setPage((p) => p + 1);
    }
  }, [trips.length, page]);

  const onRefresh = useCallback(async () => {
    if (!driverProfileId) return;
    setRefreshing(true);
    try {
      const data = await driverService.getTripHistoryFiltered({
        driverId: driverProfileId,
        page: 0,
        pageSize: PAGE_SIZE,
        status: filters.status,
        serviceType: filters.serviceType as any,
        paymentMethod: filters.paymentMethod as any,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      });
      setTrips(data);
      setPage(0);
    } catch (err) {
      console.error('Error refreshing trips:', err);
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setRefreshing(false);
    }
  }, [driverProfileId, filters]);

  const renderItem = useCallback(({ item }: { item: Ride }) => {
    const isCompleted = item.status === 'completed';
    const fare = item.final_fare_trc ?? item.estimated_fare_trc ?? item.final_fare_cup ?? item.estimated_fare_cup ?? 0;
    const rate = item.exchange_rate_usd_cup ?? DEFAULT_EXCHANGE_RATE;
    const fareUsd = trcToUsd(fare, rate);
    const deduction = item.quota_deduction_amount ?? 0;

    return (
      <Pressable onPress={() => router.push(`/trip/${item.id}`)} accessibilityRole="button" accessibilityLabel={`${isCompleted ? t('trips_history.completed', { defaultValue: 'Completado' }) : t('trips_history.canceled', { defaultValue: 'Cancelado' })}, ${item.pickup_address} → ${item.dropoff_address}, ${formatTRC(fare)}`}>
        <Card forceDark variant="filled" padding="md" className="mb-3 bg-neutral-800">
          <View className="flex-row items-center justify-between mb-2">
            <Text variant="caption" color="inverse" className="opacity-60">
              {getRelativeDay(item.created_at, t('common.today'), t('common.yesterday'))}
            </Text>
            <View className={`px-2 py-0.5 rounded-full ${isCompleted ? 'bg-green-900' : 'bg-red-900'}`}>
              <Text variant="caption" className={isCompleted ? 'text-green-400' : 'text-red-400'}>
                {isCompleted ? t('trips_history.completed', { defaultValue: 'Completado' }) : t('trips_history.canceled', { defaultValue: 'Cancelado' })}
              </Text>
            </View>
          </View>

          <View className="flex-row items-start mb-2">
            <View className="mr-3 items-center pt-1">
              <View className="w-2.5 h-2.5 rounded-full bg-primary-500" />
              <View className="w-0.5 h-4 bg-neutral-600 my-0.5" />
              <View className="w-2.5 h-2.5 rounded-full bg-neutral-400" />
            </View>
            <View className="flex-1">
              <Text variant="bodySmall" color="inverse" numberOfLines={1}>{item.pickup_address}</Text>
              <View className="h-2" />
              <Text variant="bodySmall" color="inverse" numberOfLines={1}>{item.dropoff_address}</Text>
            </View>
          </View>

          <View className="flex-row justify-between items-center">
            <View>
              <Text variant="body" color="inverse" className="font-semibold">{formatTRC(fare)}</Text>
              <Text variant="caption" color="inverse" className="opacity-40">{'\u2248'} {formatUSD(fareUsd)}</Text>
            </View>
            <View className="items-end">
              {deduction > 0 && (
                <Text variant="caption" className="text-red-400">-{formatTRC(deduction)}</Text>
              )}
              <Text variant="caption" color="inverse" className="opacity-40">{item.payment_method === 'cash' ? t('common.cash') : t('trip.tricicoin')}</Text>
            </View>
          </View>

        </Card>
      </Pressable>
    );
  }, [t]);

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4 flex-1">
        <View className="flex-row items-center justify-between mb-2">
          <Text variant="h3" color="inverse">{t('trips_history.title')}</Text>
          {trips.length > 0 && (
            <Pressable onPress={handleExportCSV} className="flex-row items-center gap-1 px-3 py-1.5 rounded-full bg-neutral-800" accessibilityRole="button" accessibilityLabel={t('trips_history.export_csv', { defaultValue: 'Exportar CSV' })}>
              <Ionicons name="download-outline" size={14} color="#9ca3af" />
              <Text variant="caption" color="inverse" className="font-medium opacity-60">CSV</Text>
            </Pressable>
          )}
        </View>

        <HistoryFilters
          filters={filters}
          onFilterChange={handleFilterChange}
          serviceTypes={serviceTypes}
          paymentMethods={paymentMethods}
          labels={filterLabels}
          dark
        />

        {error && !loading ? (
          <ErrorState
            title={t('trips_history.error_title', { defaultValue: 'Error al cargar viajes' })}
            description={error}
            onRetry={() => {
              setError(null);
              setPage(0);
            }}
            retryLabel={t('common.retry', { defaultValue: 'Reintentar' })}
          />
        ) : loading && page === 0 ? (
          <View className="px-1 pt-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonListItem key={i} />
            ))}
          </View>
        ) : (
          <FlatList
            data={trips}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                colors={['#F97316']}
                tintColor="#F97316"
              />
            }
            ListEmptyComponent={
              <EmptyState
                forceDark
                icon="car-outline"
                title={t('trips_history.no_trips')}
              />
            }
            ListFooterComponent={
              trips.length >= (page + 1) * PAGE_SIZE ? (
                <Button
                  title={t('trips_history.load_more')}
                  variant="outline"
                  size="sm"
                  forceDark
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

export default function TripsScreen() {
  if (Platform.OS === 'web') return <WebTripsScreen />;
  return <NativeTripsScreen />;
}
