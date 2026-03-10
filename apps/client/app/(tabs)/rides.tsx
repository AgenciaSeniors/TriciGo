import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, Pressable, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api/services/ride';
import { formatCUP } from '@tricigo/utils';
import type { Ride } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';

const PAGE_SIZE = 20;

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  completed: { bg: 'bg-green-100', text: 'text-green-700' },
  canceled: { bg: 'bg-red-100', text: 'text-red-700' },
};

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

export default function RidesScreen() {
  const { t } = useTranslation('rider');
  const userId = useAuthStore((s) => s.user?.id);

  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoading(true);

    async function fetchRides() {
      try {
        const data = await rideService.getRideHistory(userId!, page, PAGE_SIZE);
        if (!cancelled) {
          setRides((prev) => (page === 0 ? data : [...prev, ...data]));
        }
      } catch (err) {
        console.error('Error fetching rides:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchRides();
    return () => { cancelled = true; };
  }, [userId, page]);

  const loadMore = useCallback(() => {
    if (rides.length >= (page + 1) * PAGE_SIZE) {
      setPage((p) => p + 1);
    }
  }, [rides.length, page]);

  const renderItem = ({ item }: { item: Ride }) => {
    const isExpanded = expandedId === item.id;
    const colors = STATUS_COLORS[item.status] ?? { bg: 'bg-neutral-100', text: 'text-neutral-700' };
    const fare = item.final_fare_cup ?? item.estimated_fare_cup;

    return (
      <Pressable onPress={() => router.push(`/ride/${item.id}`)}>
        <Card variant="outlined" padding="md" className="mb-3">
          <View className="flex-row items-center justify-between mb-2">
            <Text variant="caption" color="secondary">
              {formatDate(item.created_at)}
            </Text>
            <View className={`px-2 py-0.5 rounded-full ${colors.bg}`}>
              <Text variant="caption" className={colors.text}>
                {item.status === 'completed' ? t('rides_history.completed') : t('rides_history.canceled')}
              </Text>
            </View>
          </View>

          <View className="flex-row items-start mb-2">
            <View className="mr-3 items-center pt-1">
              <View className="w-2.5 h-2.5 rounded-full bg-primary-500" />
              <View className="w-0.5 h-4 bg-neutral-300 my-0.5" />
              <View className="w-2.5 h-2.5 rounded-full bg-neutral-800" />
            </View>
            <View className="flex-1">
              <Text variant="bodySmall" numberOfLines={1}>{item.pickup_address}</Text>
              <View className="h-2" />
              <Text variant="bodySmall" numberOfLines={1}>{item.dropoff_address}</Text>
            </View>
          </View>

          <View className="flex-row justify-between items-center">
            <Text variant="body" className="font-semibold">{formatCUP(fare)}</Text>
            <Text variant="caption" color="tertiary">{item.payment_method === 'cash' ? t('payment.cash') : t('payment.tricicoin')}</Text>
          </View>

          {isExpanded && (
            <View className="mt-3 pt-3 border-t border-neutral-200">
              <View className="flex-row justify-between mb-1">
                <Text variant="caption" color="secondary">{t('rides_history.date')}</Text>
                <Text variant="caption">{new Date(item.created_at).toLocaleString('es-CU')}</Text>
              </View>
              {item.final_fare_cup != null && item.final_fare_cup !== item.estimated_fare_cup && (
                <View className="flex-row justify-between mb-1">
                  <Text variant="caption" color="secondary">{t('ride.estimated_fare')}</Text>
                  <Text variant="caption">{formatCUP(item.estimated_fare_cup)}</Text>
                </View>
              )}
            </View>
          )}
        </Card>
      </Pressable>
    );
  };

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <Text variant="h3" className="mb-4">{t('rides_history.title')}</Text>

        {loading && page === 0 ? (
          <View className="items-center py-20">
            <ActivityIndicator size="large" color="#FF4D00" />
          </View>
        ) : (
          <FlatList
            data={rides}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            ListEmptyComponent={
              <View className="items-center py-20">
                <Text variant="body" color="tertiary">{t('rides_history.no_rides')}</Text>
              </View>
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
