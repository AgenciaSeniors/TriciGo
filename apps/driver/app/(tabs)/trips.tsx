import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, Pressable, ActivityIndicator, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { driverService } from '@tricigo/api/services/driver';
import { formatCUP, generateHistoryCSV } from '@tricigo/utils';
import type { Ride } from '@tricigo/types';
import { colors } from '@tricigo/theme';
import { useDriverStore } from '@/stores/driver.store';
import { HistoryFilters } from '@tricigo/ui/HistoryFilters';
import type { HistoryFilterState } from '@tricigo/ui/HistoryFilters';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';

const PAGE_SIZE = 20;

function formatDate(dateStr: string, todayLabel: string, yesterdayLabel: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) return todayLabel;
  if (diffDays === 1) return yesterdayLabel;
  return date.toLocaleDateString('es-CU', { day: 'numeric', month: 'short' });
}

export default function TripsScreen() {
  const { t } = useTranslation('driver');
  const driverProfileId = useDriverStore((s) => s.profile?.id);

  const [trips, setTrips] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
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

  const filterLabels = {
    filters: t('trips_history.filters', { defaultValue: 'Filtros' }),
    all: t('trips_history.all_statuses', { defaultValue: 'Todos' }),
    completed: t('trips_history.completed', { defaultValue: 'Completado' }),
    canceled: t('trips_history.canceled', { defaultValue: 'Cancelado' }),
    serviceType: t('trips_history.service_type', { defaultValue: 'Tipo de servicio' }),
    paymentMethod: t('trips_history.payment_method', { defaultValue: 'Método de pago' }),
    clearFilters: t('trips_history.clear_filters', { defaultValue: 'Limpiar filtros' }),
  };

  useEffect(() => {
    if (!driverProfileId) return;
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
      const fileUri = FileSystem.cacheDirectory + 'historial_viajes.csv';
      await FileSystem.writeAsStringAsync(fileUri, csv, { encoding: FileSystem.EncodingType.UTF8 });
      await Sharing.shareAsync(fileUri, { mimeType: 'text/csv', dialogTitle: 'Exportar historial' });
    } catch (err) {
      console.error('Error exporting CSV:', err);
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
    } finally {
      setRefreshing(false);
    }
  }, [driverProfileId, filters]);

  const renderItem = ({ item }: { item: Ride }) => {
    const isExpanded = expandedId === item.id;
    const isCompleted = item.status === 'completed';
    const fare = item.final_fare_cup ?? item.estimated_fare_cup;

    return (
      <Pressable onPress={() => router.push(`/trip/${item.id}`)} accessibilityRole="button" accessibilityLabel={`${isCompleted ? t('trips_history.completed', { defaultValue: 'Completado' }) : t('trips_history.canceled', { defaultValue: 'Cancelado' })}, ${item.pickup_address} → ${item.dropoff_address}, ${formatCUP(fare)}`}>
        <Card variant="filled" padding="md" className="mb-3 bg-neutral-800">
          <View className="flex-row items-center justify-between mb-2">
            <Text variant="caption" color="inverse" className="opacity-60">
              {formatDate(item.created_at, t('common.today'), t('common.yesterday'))}
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
            <Text variant="body" color="inverse" className="font-semibold">{formatCUP(fare)}</Text>
            <Text variant="caption" color="inverse" className="opacity-40">{item.payment_method === 'cash' ? t('common.cash') : t('trip.tricicoin')}</Text>
          </View>

          {isExpanded && (
            <View className="mt-3 pt-3 border-t border-neutral-700">
              <View className="flex-row justify-between mb-1">
                <Text variant="caption" color="inverse" className="opacity-60">{t('trips_history.fare')}</Text>
                <Text variant="caption" color="inverse">{formatCUP(fare)}</Text>
              </View>
              <View className="flex-row justify-between mb-1">
                <Text variant="caption" color="inverse" className="opacity-60">{t('trips_history.date')}</Text>
                <Text variant="caption" color="inverse">{new Date(item.created_at).toLocaleString('es-CU')}</Text>
              </View>
            </View>
          )}
        </Card>
      </Pressable>
    );
  };

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

        {loading && page === 0 ? (
          <View className="items-center py-20">
            <ActivityIndicator size="large" color={colors.brand.orange} />
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
              <View className="items-center py-20">
                <Text variant="body" color="inverse" className="opacity-50">
                  {t('trips_history.no_trips')}
                </Text>
              </View>
            }
            ListFooterComponent={
              trips.length >= (page + 1) * PAGE_SIZE ? (
                <Button
                  title={t('trips_history.load_more')}
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
