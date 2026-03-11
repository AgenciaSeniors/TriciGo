import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, Pressable, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api/services/ride';
import { formatTRC } from '@tricigo/utils';
import type { Ride } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { RouteSummary } from '@tricigo/ui/RouteSummary';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { colors } from '@tricigo/theme';
import { Ionicons } from '@expo/vector-icons';

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

export default function RidesScreen() {
  const { t } = useTranslation('rider');
  const userId = useAuthStore((s) => s.user?.id);

  const [rides, setRides] = useState<Ride[]>([]);
  const [scheduledRides, setScheduledRides] = useState<Ride[]>([]);
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
    const fare = item.final_fare_trc ?? item.estimated_fare_trc ?? item.estimated_fare_cup;

    return (
      <Pressable onPress={() => router.push(`/ride/${item.id}`)}>
        <Card variant="outlined" padding="md" className="mb-3">
          <View className="flex-row items-center justify-between mb-2">
            <Text variant="caption" color="secondary">
              {formatDate(item.created_at)}
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

          {isExpanded && (
            <View className="mt-3 pt-3 border-t border-neutral-200">
              <View className="flex-row justify-between mb-1">
                <Text variant="caption" color="secondary">{t('rides_history.date')}</Text>
                <Text variant="caption">{new Date(item.created_at).toLocaleString('es-CU')}</Text>
              </View>
              {item.final_fare_trc != null && item.estimated_fare_trc != null && item.final_fare_trc !== item.estimated_fare_trc && (
                <View className="flex-row justify-between mb-1">
                  <Text variant="caption" color="secondary">{t('ride.estimated_fare')}</Text>
                  <Text variant="caption">{formatTRC(item.estimated_fare_trc)}</Text>
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

        {loading && page === 0 ? (
          <View className="items-center py-20">
            <ActivityIndicator size="large" color={colors.brand.orange} />
          </View>
        ) : (
          <FlatList
            data={rides}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
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
