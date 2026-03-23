import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Alert, ActivityIndicator, ScrollView, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { recurringRideService, useFeatureFlag } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { ErrorState } from '@tricigo/ui/ErrorState';
import type { RecurringRide } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';
import { CreateRecurringRideSheet } from '@/components/CreateRecurringRideSheet';
import { EditRecurringRideSheet } from '@/components/EditRecurringRideSheet';

const DAY_KEYS = ['day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat', 'day_sun'] as const;

function formatNextOccurrence(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('es-CU', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function RecurringRidesScreen() {
  const { t } = useTranslation('rider');
  const userId = useAuthStore((s) => s.user?.id);
  const enabled = useFeatureFlag('recurring_rides_enabled');

  const [rides, setRides] = useState<RecurringRide[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingRide, setEditingRide] = useState<RecurringRide | null>(null);

  const fetchRides = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await recurringRideService.getRecurringRides(userId);
      setRides(data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchRides();
  }, [fetchRides]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchRides();
    setRefreshing(false);
  }, [fetchRides]);

  const handlePause = useCallback(async (id: string) => {
    setActionLoading(id);
    try {
      await recurringRideService.pauseRecurringRide(id);
      await fetchRides();
    } catch { /* best-effort */ }
    setActionLoading(null);
  }, [fetchRides]);

  const handleResume = useCallback(async (id: string) => {
    setActionLoading(id);
    try {
      await recurringRideService.resumeRecurringRide(id);
      await fetchRides();
    } catch { /* best-effort */ }
    setActionLoading(null);
  }, [fetchRides]);

  const handleDelete = useCallback((id: string) => {
    Alert.alert(
      t('recurring.delete_confirm'),
      t('recurring.delete_confirm_body'),
      [
        { text: t('common:cancel'), style: 'cancel' },
        {
          text: t('recurring.delete'),
          style: 'destructive',
          onPress: async () => {
            setActionLoading(id);
            try {
              await recurringRideService.deleteRecurringRide(id);
              await fetchRides();
            } catch { /* best-effort */ }
            setActionLoading(null);
          },
        },
      ],
    );
  }, [t, fetchRides]);

  const handleCreated = useCallback(() => {
    setShowCreate(false);
    fetchRides();
  }, [fetchRides]);

  const handleUpdated = useCallback(() => {
    setEditingRide(null);
    fetchRides();
  }, [fetchRides]);

  if (error) return <ErrorState title="Error" description={error} onRetry={() => { setError(null); fetchRides(); }} />;

  if (!enabled) {
    return (
      <Screen>
        <ScreenHeader title={t('recurring.title')} onBack={() => router.back()} />
        <View className="flex-1 items-center justify-center px-6">
          <Ionicons name="time-outline" size={48} color={colors.neutral[300]} />
          <Text className="text-neutral-400 mt-3 text-center">Próximamente</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title={t('recurring.title')}
        onBack={() => router.back()}
        rightAction={
          <Pressable onPress={() => setShowCreate(true)} hitSlop={8}>
            <Ionicons name="add-circle-outline" size={26} color={colors.primary[500]} />
          </Pressable>
        }
      />

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={colors.primary[500]} />
        </View>
      ) : rides.length === 0 ? (
        <View className="flex-1 items-center justify-center px-6">
          <Ionicons name="repeat-outline" size={48} color={colors.neutral[300]} />
          <Text className="text-lg font-semibold text-neutral-500 mt-4">{t('recurring.empty')}</Text>
          <Text className="text-sm text-neutral-400 mt-1 text-center">{t('recurring.empty_description')}</Text>
          <Button
            title={t('recurring.create')}
            size="md"
            onPress={() => setShowCreate(true)}
            className="mt-6"
          />
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, gap: 12 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#FF4D00" />
          }
        >
          {rides.map((ride) => (
            <Card key={ride.id} variant="outlined" padding="md">
              {/* Route */}
              <View className="flex-row items-start mb-2">
                <View className="mt-1 mr-2">
                  <View className="w-2.5 h-2.5 rounded-full bg-primary-500" />
                  <View className="w-px h-3 bg-neutral-200 ml-[4px]" />
                  <View className="w-2.5 h-2.5 rounded-full bg-neutral-400" />
                </View>
                <View className="flex-1">
                  <Text className="text-sm text-neutral-900" numberOfLines={1}>{ride.pickup_address}</Text>
                  <View className="h-1" />
                  <Text className="text-sm text-neutral-600" numberOfLines={1}>{ride.dropoff_address}</Text>
                </View>
                <StatusBadge
                  label={ride.status === 'active' ? t('recurring.status_active') : t('recurring.status_paused')}
                  variant={ride.status === 'active' ? 'success' : 'neutral'}
                />
              </View>

              {/* Days of week chips */}
              <View className="flex-row gap-1 mb-2">
                {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                  const isActive = ride.days_of_week.includes(day);
                  return (
                    <View
                      key={day}
                      className={`w-7 h-7 rounded-full items-center justify-center ${
                        isActive ? 'bg-primary-500' : 'bg-neutral-100'
                      }`}
                    >
                      <Text className={`text-xs font-semibold ${isActive ? 'text-white' : 'text-neutral-400'}`}>
                        {t(`recurring.${DAY_KEYS[day - 1]}`)}
                      </Text>
                    </View>
                  );
                })}
                <View className="ml-2 flex-row items-center">
                  <Ionicons name="time-outline" size={14} color={colors.neutral[500]} />
                  <Text className="text-sm text-neutral-600 ml-1">{ride.time_of_day}</Text>
                </View>
              </View>

              {/* Next occurrence */}
              {ride.next_occurrence_at && (
                <Text className="text-xs text-neutral-400 mb-2">
                  {t('recurring.next_ride', { date: formatNextOccurrence(ride.next_occurrence_at) })}
                </Text>
              )}

              {/* Actions */}
              <View className="flex-row gap-2 pt-2 border-t border-neutral-100">
                {actionLoading === ride.id ? (
                  <ActivityIndicator size="small" color={colors.primary[500]} />
                ) : (
                  <>
                    <Pressable
                      onPress={() =>
                        ride.status === 'active' ? handlePause(ride.id) : handleResume(ride.id)
                      }
                      className="flex-row items-center gap-1 px-3 py-1.5 rounded-lg bg-neutral-100"
                    >
                      <Ionicons
                        name={ride.status === 'active' ? 'pause-outline' : 'play-outline'}
                        size={14}
                        color={colors.neutral[600]}
                      />
                      <Text className="text-xs font-medium text-neutral-600">
                        {ride.status === 'active' ? t('recurring.pause') : t('recurring.resume')}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setEditingRide(ride)}
                      className="flex-row items-center gap-1 px-3 py-1.5 rounded-lg bg-neutral-100"
                    >
                      <Ionicons name="pencil-outline" size={14} color={colors.neutral[600]} />
                      <Text className="text-xs font-medium text-neutral-600">
                        {t('recurring.edit_btn', { defaultValue: 'Editar' })}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => handleDelete(ride.id)}
                      className="flex-row items-center gap-1 px-3 py-1.5 rounded-lg bg-red-50"
                    >
                      <Ionicons name="trash-outline" size={14} color={colors.error} />
                      <Text className="text-xs font-medium text-red-600">{t('recurring.delete')}</Text>
                    </Pressable>
                  </>
                )}
              </View>
            </Card>
          ))}
        </ScrollView>
      )}

      <CreateRecurringRideSheet
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={handleCreated}
      />

      <EditRecurringRideSheet
        ride={editingRide}
        visible={!!editingRide}
        onClose={() => setEditingRide(null)}
        onUpdated={handleUpdated}
      />
    </Screen>
  );
}
