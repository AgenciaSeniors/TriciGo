import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { driverService } from '@tricigo/api';
import { formatCUP } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { colors } from '@tricigo/theme';
import { Ionicons } from '@expo/vector-icons';
import { ErrorState } from '@tricigo/ui/ErrorState';
import type { CancellationPenalty } from '@tricigo/types';

export default function PenaltiesScreen() {
  const { t } = useTranslation('driver');
  const userId = useAuthStore((s) => s.user?.id);

  const [penalties, setPenalties] = useState<CancellationPenalty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await driverService.getCancellationPenalties(userId, 50);
      setPenalties(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchData();
  }, [fetchData]);

  const totalAmount = penalties.reduce((sum, p) => sum + p.amount, 0);

  const renderPenalty = ({ item }: { item: CancellationPenalty }) => (
    <Card theme="light" variant="filled" padding="md" className="mb-2 bg-white">
      <View className="flex-row items-center justify-between">
        <View className="flex-1 mr-3">
          <Text variant="bodySmall" color="primary">
            {item.reason
              ? t(`penalties.reason_${item.reason}`, { defaultValue: item.reason.replace(/_/g, ' ') })
              : t('penalties.cancellation', { defaultValue: 'Cancelación de viaje' })}
          </Text>
          <Text variant="caption" color="primary" className="opacity-50 mt-0.5">
            {new Date(item.created_at).toLocaleDateString('es-CU', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        </View>
        <Text variant="body" className="text-red-400 font-semibold">
          -{formatCUP(item.amount)}
        </Text>
      </View>
    </Card>
  );

  if (error) return <ErrorState title="Error" description={error} onRetry={() => { setError(null); fetchData(); }} />;

  return (
    <Screen bg="lightPrimary" statusBarStyle="dark-content">
      <View className="pt-4 px-5 flex-1">
        <ScreenHeader
          title={t('penalties.title', { defaultValue: 'Penalidades' })}
          onBack={() => router.back()}
        />

        {/* Summary */}
        {penalties.length > 0 && (
          <Card theme="light" variant="filled" padding="md" className="bg-red-50 mb-4 mt-2">
            <View className="flex-row items-center gap-2">
              <Ionicons name="warning-outline" size={20} color="#EF4444" />
              <View>
                <Text variant="bodySmall" color="primary">
                  {t('penalties.total', { defaultValue: 'Total penalidades' })}
                </Text>
                <Text variant="h4" className="text-red-400">
                  -{formatCUP(totalAmount)}
                </Text>
              </View>
            </View>
            <Text variant="caption" color="primary" className="opacity-50 mt-2">
              {t('penalties.description', { defaultValue: 'Las penalidades se aplican por cancelaciones frecuentes o tardías. Mantén una baja tasa de cancelación para evitarlas.' })}
            </Text>
          </Card>
        )}

        <FlatList
          data={penalties}
          keyExtractor={(item) => item.id}
          renderItem={renderPenalty}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#64748B" />
          }
          ListEmptyComponent={
            !loading ? (
              <View className="items-center py-12">
                <Ionicons name="checkmark-circle-outline" size={48} color={colors.neutral[600]} />
                <Text variant="body" color="primary" className="opacity-30 mt-3">
                  {t('penalties.no_penalties', { defaultValue: 'No tienes penalidades' })}
                </Text>
              </View>
            ) : null
          }
        />
      </View>
    </Screen>
  );
}
