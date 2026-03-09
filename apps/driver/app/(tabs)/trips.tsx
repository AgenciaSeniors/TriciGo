import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, Pressable, ActivityIndicator } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { driverService } from '@tricigo/api/services/driver';
import { formatCUP } from '@tricigo/utils';
import type { Ride } from '@tricigo/types';
import { useDriverStore } from '@/stores/driver.store';

const PAGE_SIZE = 20;

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) return 'Hoy';
  if (diffDays === 1) return 'Ayer';
  return date.toLocaleDateString('es-CU', { day: 'numeric', month: 'short' });
}

export default function TripsScreen() {
  const { t } = useTranslation('driver');
  const driverProfileId = useDriverStore((s) => s.profile?.id);

  const [trips, setTrips] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!driverProfileId) return;
    let cancelled = false;
    setLoading(true);

    async function fetchTrips() {
      try {
        const data = await driverService.getTripHistory(driverProfileId!, page, PAGE_SIZE);
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
  }, [driverProfileId, page]);

  const loadMore = useCallback(() => {
    if (trips.length >= (page + 1) * PAGE_SIZE) {
      setPage((p) => p + 1);
    }
  }, [trips.length, page]);

  const renderItem = ({ item }: { item: Ride }) => {
    const isExpanded = expandedId === item.id;
    const isCompleted = item.status === 'completed';
    const fare = item.final_fare_cup ?? item.estimated_fare_cup;

    return (
      <Pressable onPress={() => setExpandedId(isExpanded ? null : item.id)}>
        <Card variant="filled" padding="md" className="mb-3 bg-neutral-800">
          <View className="flex-row items-center justify-between mb-2">
            <Text variant="caption" color="inverse" className="opacity-60">
              {formatDate(item.created_at)}
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
            <Text variant="caption" color="inverse" className="opacity-40">{item.payment_method === 'cash' ? 'Efectivo' : 'TriciCoin'}</Text>
          </View>

          {isExpanded && (
            <View className="mt-3 pt-3 border-t border-neutral-700">
              <View className="flex-row justify-between mb-1">
                <Text variant="caption" color="inverse" className="opacity-60">{t('trips_history.fare')}</Text>
                <Text variant="caption" color="inverse">{formatCUP(fare)}</Text>
              </View>
              <View className="flex-row justify-between mb-1">
                <Text variant="caption" color="inverse" className="opacity-60">Fecha</Text>
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
        <Text variant="h3" color="inverse" className="mb-4">{t('trips_history.title')}</Text>

        {loading && page === 0 ? (
          <View className="items-center py-20">
            <ActivityIndicator size="large" color="#FF4D00" />
          </View>
        ) : (
          <FlatList
            data={trips}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
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
