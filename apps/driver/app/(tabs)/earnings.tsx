import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, ScrollView, RefreshControl, Alert, ActivityIndicator, Pressable, Dimensions } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { Input } from '@tricigo/ui/Input';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { driverService } from '@tricigo/api/services/driver';
import { reviewService } from '@tricigo/api/services/review';
import { questService } from '@tricigo/api/services/quest';
import { formatCUP, formatTriciCoin, centavosToUnits } from '@tricigo/utils';
import type { Ride, WalletRedemption, QuestWithProgress } from '@tricigo/types';
import { colors } from '@tricigo/theme';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';
import { EarningsBarChart } from '@/components/EarningsBarChart';
import type { BarChartDataPoint } from '@/components/EarningsBarChart';
import { HourlyHeatmap } from '@/components/HourlyHeatmap';

type Period = 'day' | 'week' | 'month';

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  requested: { bg: 'bg-warning-light', text: 'text-warning-dark' },
  approved: { bg: 'bg-success-light', text: 'text-success-dark' },
  processed: { bg: 'bg-info-light', text: 'text-info-dark' },
  rejected: { bg: 'bg-error-light', text: 'text-error-dark' },
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  requested: 'earnings.status_requested',
  approved: 'earnings.status_approved',
  processed: 'earnings.status_processed',
  rejected: 'earnings.status_rejected',
};

function getDateRange(period: Period): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  switch (period) {
    case 'day': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      return { start, end };
    }
    case 'week': {
      const dayOfWeek = now.getDay();
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
      monday.setHours(0, 0, 0, 0);
      return { start: monday, end };
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      return { start, end };
    }
  }
}

function getPreviousDateRange(period: Period): { start: Date; end: Date } {
  const current = getDateRange(period);
  const durationMs = current.end.getTime() - current.start.getTime();
  return {
    start: new Date(current.start.getTime() - durationMs - 1),
    end: new Date(current.start.getTime() - 1),
  };
}

function groupTripsByDay(trips: Ride[]): Map<string, { earnings: number; count: number }> {
  const grouped = new Map<string, { earnings: number; count: number }>();
  for (const trip of trips) {
    const dateKey = new Date(trip.completed_at ?? trip.created_at).toLocaleDateString('es-CU', {
      day: '2-digit',
      month: '2-digit',
    });
    const existing = grouped.get(dateKey) ?? { earnings: 0, count: 0 };
    existing.earnings += trip.final_fare_cup ?? trip.estimated_fare_cup;
    existing.count += 1;
    grouped.set(dateKey, existing);
  }
  return grouped;
}

// Simple bar chart component
function EarningsChart({ data }: { data: Map<string, { earnings: number; count: number }> }) {
  const entries = Array.from(data.entries());
  if (entries.length === 0) return null;

  const maxEarnings = Math.max(...entries.map(([, v]) => v.earnings), 1);
  const barWidth = Math.min(40, (Dimensions.get('window').width - 80) / Math.max(entries.length, 1));

  return (
    <View className="bg-neutral-800 rounded-xl p-4 mb-4">
      <View className="flex-row items-end justify-center" style={{ height: 120 }}>
        {entries.map(([day, val]) => {
          const height = Math.max((val.earnings / maxEarnings) * 100, 4);
          return (
            <View key={day} className="items-center mx-1" style={{ width: barWidth }}>
              <Text variant="caption" color="inverse" className="text-xs opacity-70 mb-1">
                {formatCUP(val.earnings).replace(' CUP', '')}
              </Text>
              <View
                className="rounded-t-sm"
                style={{
                  height,
                  width: barWidth - 4,
                  backgroundColor: colors.brand.orange,
                }}
              />
              <Text variant="caption" color="inverse" className="text-xs opacity-50 mt-1">
                {day}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export default function EarningsScreen() {
  const { t } = useTranslation('driver');
  const userId = useAuthStore((s) => s.user?.id);
  const driverProfileId = useDriverStore((s) => s.profile?.id);

  const [period, setPeriod] = useState<Period>('day');
  const [balance, setBalance] = useState(0);
  const [periodTrips, setPeriodTrips] = useState<Ride[]>([]);
  const [commissionRate, setCommissionRate] = useState(0.15);
  const [avgRating, setAvgRating] = useState<number | null>(null);
  const [totalReviews, setTotalReviews] = useState(0);
  const [totalTripsCount, setTotalTripsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Withdrawal state
  const [sheetVisible, setSheetVisible] = useState(false);
  const [redeemAmount, setRedeemAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [redemptions, setRedemptions] = useState<WalletRedemption[]>([]);
  const [prevPeriodEarnings, setPrevPeriodEarnings] = useState<number | null>(null);
  const [quests, setQuests] = useState<QuestWithProgress[]>([]);
  const [driverStats, setDriverStats] = useState<{
    acceptanceRate: number;
    cancellationRate: number;
    completionRate: number;
    ridesThisWeek: number;
    ridesThisMonth: number;
    avgResponseTimeS: number | null;
    matchScore: number;
  } | null>(null);

  const fetchData = useCallback(async () => {
    if (!userId || !driverProfileId) return;
    try {
      const { start, end } = getDateRange(period);

      const [balanceData, trips, redHistory, commRateStr, ratingData] = await Promise.all([
        walletService.getBalance(userId),
        driverService.getTripHistoryByDateRange(
          driverProfileId,
          start.toISOString(),
          end.toISOString(),
        ),
        walletService.getRedemptions(driverProfileId),
        walletService.getConfigValue('commission_rate').catch(() => null),
        reviewService.getReviewSummary(userId).catch(() => null),
      ]);

      setBalance(balanceData.available);
      setPeriodTrips(trips);
      setRedemptions(redHistory);

      const parsedRate = commRateStr ? parseFloat(String(commRateStr).replace(/"/g, '')) : NaN;
      setCommissionRate(!isNaN(parsedRate) && parsedRate > 0 && parsedRate < 1 ? parsedRate : 0.15);

      // Total trips (all time)
      const allTrips = await driverService.getTripHistory(driverProfileId, 0, 1000);
      setTotalTripsCount(allTrips.filter((t) => t.status === 'completed').length);

      if (ratingData) {
        setAvgRating(ratingData.average_rating);
        setTotalReviews(ratingData.total_reviews);
      }

      // Fetch quests
      try {
        const questData = await questService.getDriverQuestProgress(driverProfileId);
        setQuests(questData);
      } catch { /* non-critical */ }

      // Fetch driver performance stats
      try {
        const stats = await driverService.getDriverStats(driverProfileId);
        setDriverStats(stats);
      } catch { /* non-critical */ }

      // Fetch previous period for trend comparison
      try {
        const prev = getPreviousDateRange(period);
        const prevTrips = await driverService.getTripHistoryByDateRange(
          driverProfileId,
          prev.start.toISOString(),
          prev.end.toISOString(),
        );
        let prevTotal = 0;
        for (const trip of prevTrips) {
          prevTotal += trip.final_fare_cup ?? trip.estimated_fare_cup;
        }
        setPrevPeriodEarnings(prevTotal);
      } catch {
        setPrevPeriodEarnings(null);
      }
    } catch (err) {
      console.error('Error fetching earnings:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId, driverProfileId, period]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchData();
  }, [fetchData]);

  // Computed stats
  const periodStats = useMemo(() => {
    let totalEarnings = 0;
    let totalCommission = 0;
    let completedCount = 0;

    for (const trip of periodTrips) {
      const fare = trip.final_fare_cup ?? trip.estimated_fare_cup;
      totalEarnings += fare;
      totalCommission += Math.round(fare * commissionRate);
      completedCount++;
    }

    const avgPerTrip = completedCount > 0 ? Math.round(totalEarnings / completedCount) : 0;
    const netEarnings = totalEarnings - totalCommission;

    return { totalEarnings, totalCommission, netEarnings, completedCount, avgPerTrip };
  }, [periodTrips, commissionRate]);

  const dailyData = useMemo(() => groupTripsByDay(periodTrips), [periodTrips]);

  // Convert dailyData to BarChartDataPoint[]
  const chartData: BarChartDataPoint[] = useMemo(() => {
    const today = new Date().toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit' });
    return Array.from(dailyData.entries()).map(([label, val]) => ({
      label,
      value: val.earnings,
      isToday: label === today,
    }));
  }, [dailyData]);

  // Trend percentage
  const trendPct = useMemo(() => {
    if (prevPeriodEarnings == null || prevPeriodEarnings === 0) return null;
    return Math.round(((periodStats.totalEarnings - prevPeriodEarnings) / prevPeriodEarnings) * 100);
  }, [periodStats.totalEarnings, prevPeriodEarnings]);

  const handleRedeem = () => {
    setRedeemAmount('');
    setSheetVisible(true);
  };

  const handleConfirmRedeem = async () => {
    if (!driverProfileId) return;
    const parsed = parseFloat(redeemAmount);
    if (isNaN(parsed) || parsed <= 0) {
      Alert.alert('Error', t('earnings.amount_error_min'));
      return;
    }
    const amountCentavos = Math.round(parsed * 100);
    if (amountCentavos > balance) {
      Alert.alert('Error', t('earnings.amount_error_max'));
      return;
    }
    setSubmitting(true);
    try {
      await walletService.requestRedemption(driverProfileId, amountCentavos);
      setSheetVisible(false);
      Alert.alert('', t('earnings.withdrawal_success'));
      fetchData();
    } catch (err) {
      console.error('Error requesting redemption:', err);
      Alert.alert('Error', t('earnings.withdrawal_info'));
    } finally {
      setSubmitting(false);
    }
  };

  const periodLabels: Record<Period, string> = {
    day: t('earnings.today', { defaultValue: 'Hoy' }),
    week: t('earnings.week', { defaultValue: 'Semana' }),
    month: t('earnings.month', { defaultValue: 'Mes' }),
  };

  return (
    <Screen bg="dark" statusBarStyle="light-content">
      <ScrollView
        className="flex-1 px-5"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />
        }
      >
        <View className="pt-4 pb-8">
          <Text variant="h3" color="inverse" className="mb-4">
            {t('earnings.title')}
          </Text>

          {loading ? (
            <View className="items-center justify-center py-20">
              <ActivityIndicator size="large" color={colors.brand.orange} />
            </View>
          ) : (
          <>
          <BalanceBadge
            balance={balance}
            size="lg"
            className="mb-6"
          />

          {/* Period Tabs */}
          <View className="flex-row gap-2 mb-4" accessibilityRole="tablist">
            {(['day', 'week', 'month'] as Period[]).map((p) => (
              <Pressable
                key={p}
                onPress={() => setPeriod(p)}
                className={`flex-1 py-2.5 rounded-full items-center ${
                  period === p ? 'bg-primary-500' : 'bg-neutral-800'
                }`}
                accessibilityRole="tab"
                accessibilityState={{ selected: period === p }}
                accessibilityLabel={periodLabels[p]}
              >
                <Text
                  variant="bodySmall"
                  color="inverse"
                  className={`font-semibold ${period === p ? '' : 'opacity-60'}`}
                >
                  {periodLabels[p]}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Bar Chart (SVG) */}
          {period !== 'day' && chartData.length > 0 && (
            <EarningsBarChart data={chartData} />
          )}

          {/* Period Stats */}
          <View className="flex-row gap-3 mb-2">
            <Card variant="filled" padding="md" className="flex-1 bg-neutral-800">
              <Text variant="caption" color="inverse" className="opacity-50">
                {t('earnings.net_today', { defaultValue: 'Ganancia neta' })}
              </Text>
              <Text variant="h4" color="inverse" className="mt-1">
                {formatCUP(periodStats.netEarnings)}
              </Text>
              {periodStats.totalCommission > 0 && (
                <Text variant="caption" className="text-red-400 mt-0.5">
                  {t('earnings.commission_label', { defaultValue: 'Comision' })}: {formatCUP(periodStats.totalCommission)}
                </Text>
              )}
              {trendPct !== null && (
                <Text
                  variant="caption"
                  className={`mt-0.5 ${trendPct >= 0 ? 'text-green-400' : 'text-red-400'}`}
                >
                  {trendPct >= 0
                    ? t('earnings.trend_up', { pct: trendPct, defaultValue: `+${trendPct}% vs anterior` })
                    : t('earnings.trend_down', { pct: Math.abs(trendPct), defaultValue: `${trendPct}% vs anterior` })}
                </Text>
              )}
            </Card>
            <Card variant="filled" padding="md" className="flex-1 bg-neutral-800">
              <Text variant="caption" color="inverse" className="opacity-50">
                {t('earnings.total_trips')}
              </Text>
              <Text variant="h4" color="inverse" className="mt-1">
                {periodStats.completedCount}
              </Text>
            </Card>
          </View>

          {/* Avg per trip */}
          <View className="flex-row gap-3 mb-4">
            <Card variant="filled" padding="md" className="flex-1 bg-neutral-800">
              <Text variant="caption" color="inverse" className="opacity-50">
                {t('earnings.avg_per_trip', { defaultValue: 'Promedio por viaje' })}
              </Text>
              <Text variant="h4" color="inverse" className="mt-1">
                {formatCUP(periodStats.avgPerTrip)}
              </Text>
            </Card>
            <Card variant="filled" padding="md" className="flex-1 bg-neutral-800">
              <Text variant="caption" color="inverse" className="opacity-50">
                {t('earnings.rating')}
              </Text>
              <View className="flex-row items-center mt-1">
                <Text variant="h4" color="inverse" className="mr-1">
                  {avgRating != null ? `★ ${avgRating.toFixed(1)}` : '★ —'}
                </Text>
                {totalReviews > 0 && (
                  <Text variant="caption" color="inverse" className="opacity-50">
                    ({totalReviews})
                  </Text>
                )}
              </View>
            </Card>
          </View>

          {/* Hourly Heatmap */}
          {periodTrips.length > 0 && (
            <HourlyHeatmap trips={periodTrips} />
          )}

          <Button
            title={t('earnings.redeem')}
            variant="outline"
            size="lg"
            fullWidth
            loading={submitting}
            disabled={balance <= 0}
            onPress={handleRedeem}
          />

          {/* Withdrawal history */}
          {redemptions.length > 0 && (
            <View className="mt-8">
              <Text variant="h4" color="inverse" className="mb-3">
                {t('earnings.withdrawal_history')}
              </Text>
              {redemptions.map((r) => {
                const statusColors = STATUS_COLORS[r.status] ?? { bg: 'bg-warning-light', text: 'text-warning-dark' };
                const labelKey = STATUS_LABEL_KEYS[r.status];
                const label = labelKey ? t(labelKey) : r.status;
                return (
                  <Card key={r.id} variant="filled" padding="md" className="mb-2 bg-neutral-800">
                    <View className="flex-row items-center justify-between">
                      <View>
                        <Text variant="body" color="inverse" className="font-semibold">
                          {formatTriciCoin(r.amount)}
                        </Text>
                        <Text variant="caption" color="inverse" className="opacity-50 mt-0.5">
                          {new Date(r.requested_at).toLocaleDateString('es-CU', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </Text>
                      </View>
                      <View className={`px-2 py-0.5 rounded-full ${statusColors.bg}`}>
                        <Text className={`text-xs font-medium ${statusColors.text}`}>
                          {label}
                        </Text>
                      </View>
                    </View>
                    {r.rejection_reason && (
                      <Text variant="caption" className="text-red-400 mt-1">
                        {r.rejection_reason}
                      </Text>
                    )}
                  </Card>
                );
              })}
            </View>
          )}

          {/* Quests / Missions */}
          <View className="mt-8">
            <Text variant="h4" color="inverse" className="mb-3">
              {t('earnings.quests_title', { defaultValue: 'Misiones' })}
            </Text>
            {quests.length === 0 ? (
              <Text variant="bodySmall" color="inverse" className="opacity-50">
                {t('earnings.no_quests', { defaultValue: 'No hay misiones activas' })}
              </Text>
            ) : (
              quests.map((q) => {
                const isCompleted = !!q.progress?.completed_at;
                const current = q.progress?.current_value ?? 0;
                const progress = Math.min(current / q.target_value, 1);
                const title = q.title_es; // TODO: use i18n language
                const desc = q.description_es;

                return (
                  <Card key={q.id} variant="filled" padding="md" className={`mb-3 ${isCompleted ? 'bg-green-900/30' : 'bg-neutral-800'}`}>
                    <View className="flex-row items-center justify-between mb-1">
                      <Text variant="body" color="inverse" className="font-semibold flex-1 mr-2">
                        {isCompleted ? '✅ ' : ''}{title}
                      </Text>
                      <Text variant="caption" className="text-primary-400 font-bold">
                        +{formatCUP(q.reward_cup)}
                      </Text>
                    </View>
                    <Text variant="caption" color="inverse" className="opacity-60 mb-2">
                      {desc}
                    </Text>
                    {/* Progress bar */}
                    <View
                      className="h-2 bg-neutral-700 rounded-full overflow-hidden mb-1"
                      accessibilityRole="progressbar"
                      accessibilityValue={{ min: 0, max: q.target_value, now: current }}
                    >
                      <View
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.round(progress * 100)}%`,
                          backgroundColor: isCompleted ? '#22c55e' : colors.brand.orange,
                        }}
                      />
                    </View>
                    <Text variant="caption" color="inverse" className="opacity-50">
                      {current} / {q.target_value} {isCompleted
                        ? t('earnings.quest_completed', { defaultValue: '¡Completada!' })
                        : t('earnings.quest_remaining', { defaultValue: 'restante' })}
                    </Text>
                  </Card>
                );
              })
            )}
          </View>

          {/* Performance Metrics */}
          {driverStats && (
            <View className="mt-8">
              <Text variant="h4" color="inverse" className="mb-3">
                {t('earnings.performance_title', { defaultValue: 'Rendimiento' })}
              </Text>
              <View className="flex-row gap-3 mb-3">
                <Card variant="filled" padding="md" className="flex-1 bg-neutral-800" accessible={true} accessibilityLabel={`${t('earnings.acceptance_rate', { defaultValue: 'Tasa aceptación' })}: ${Math.round(driverStats.acceptanceRate * 100)}%`}>
                  <Text variant="caption" color="inverse" className="opacity-50">
                    {t('earnings.acceptance_rate', { defaultValue: 'Tasa aceptación' })}
                  </Text>
                  <Text variant="h4" color="inverse" className="mt-1">
                    {Math.round(driverStats.acceptanceRate * 100)}%
                  </Text>
                </Card>
                <Card variant="filled" padding="md" className="flex-1 bg-neutral-800" accessible={true} accessibilityLabel={`${t('earnings.completion_rate', { defaultValue: 'Tasa completado' })}: ${Math.round(driverStats.completionRate * 100)}%`}>
                  <Text variant="caption" color="inverse" className="opacity-50">
                    {t('earnings.completion_rate', { defaultValue: 'Tasa completado' })}
                  </Text>
                  <Text variant="h4" color="inverse" className="mt-1">
                    {Math.round(driverStats.completionRate * 100)}%
                  </Text>
                </Card>
              </View>
              <View className="flex-row gap-3 mb-3">
                <Card variant="filled" padding="md" className="flex-1 bg-neutral-800" accessible={true} accessibilityLabel={`${t('earnings.cancellation_rate', { defaultValue: 'Tasa cancelación' })}: ${Math.round(driverStats.cancellationRate * 100)}%`}>
                  <Text variant="caption" color="inverse" className="opacity-50">
                    {t('earnings.cancellation_rate', { defaultValue: 'Tasa cancelación' })}
                  </Text>
                  <Text variant="h4" style={{ color: driverStats.cancellationRate > 0.15 ? '#EF4444' : '#fff' }} className="mt-1">
                    {Math.round(driverStats.cancellationRate * 100)}%
                  </Text>
                </Card>
                <Card variant="filled" padding="md" className="flex-1 bg-neutral-800" accessible={true} accessibilityLabel={`${t('earnings.avg_response_time', { defaultValue: 'Tiempo respuesta' })}: ${driverStats.avgResponseTimeS != null ? `${driverStats.avgResponseTimeS}s` : '—'}`}>
                  <Text variant="caption" color="inverse" className="opacity-50">
                    {t('earnings.avg_response_time', { defaultValue: 'Tiempo respuesta' })}
                  </Text>
                  <Text variant="h4" color="inverse" className="mt-1">
                    {driverStats.avgResponseTimeS != null ? `${driverStats.avgResponseTimeS}s` : '—'}
                  </Text>
                </Card>
              </View>
              <View className="flex-row gap-3">
                <Card variant="filled" padding="md" className="flex-1 bg-neutral-800" accessible={true} accessibilityLabel={`${t('earnings.rides_this_week', { defaultValue: 'Esta semana' })}: ${driverStats.ridesThisWeek}`}>
                  <Text variant="caption" color="inverse" className="opacity-50">
                    {t('earnings.rides_this_week', { defaultValue: 'Esta semana' })}
                  </Text>
                  <Text variant="h4" color="inverse" className="mt-1">
                    {driverStats.ridesThisWeek}
                  </Text>
                </Card>
                <Card variant="filled" padding="md" className="flex-1 bg-neutral-800" accessible={true} accessibilityLabel={`${t('earnings.match_score', { defaultValue: 'Puntuación' })}: ${driverStats.matchScore}`}>
                  <Text variant="caption" color="inverse" className="opacity-50">
                    {t('earnings.match_score', { defaultValue: 'Puntuación' })}
                  </Text>
                  <Text variant="h4" color="inverse" className="mt-1">
                    {driverStats.matchScore}
                  </Text>
                </Card>
              </View>
            </View>
          )}
          </>
          )}
        </View>
      </ScrollView>

      {/* Withdrawal BottomSheet */}
      <BottomSheet visible={sheetVisible} onClose={() => setSheetVisible(false)}>
        <Text className="text-lg font-bold mb-4">{t('earnings.request_withdrawal')}</Text>
        <Input
          label={t('earnings.redeem_amount')}
          placeholder="0.00"
          keyboardType="decimal-pad"
          value={redeemAmount}
          onChangeText={setRedeemAmount}
          hint={`${t('earnings.balance')}: ${formatTriciCoin(balance)}`}
        />
        <Button
          title={t('earnings.redeem_confirm_btn')}
          variant="primary"
          size="lg"
          fullWidth
          loading={submitting}
          disabled={!redeemAmount.trim()}
          onPress={handleConfirmRedeem}
        />
      </BottomSheet>
    </Screen>
  );
}
