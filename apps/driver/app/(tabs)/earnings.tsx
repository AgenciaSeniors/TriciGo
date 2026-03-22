import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { View, ScrollView, RefreshControl, ActivityIndicator, Pressable, Dimensions, TextInput } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import { SkeletonBalance, SkeletonCard } from '@tricigo/ui/Skeleton';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import i18next from 'i18next';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { driverService } from '@tricigo/api/services/driver';
import { reviewService } from '@tricigo/api/services/review';
import { questService } from '@tricigo/api/services/quest';
import { formatCUP } from '@tricigo/utils';
import type { Ride, QuestWithProgress } from '@tricigo/types';
import { colors } from '@tricigo/theme';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';
import { EarningsBarChart } from '@/components/EarningsBarChart';
import type { BarChartDataPoint } from '@/components/EarningsBarChart';
import { Platform } from 'react-native';
import { HourlyHeatmap } from '@/components/HourlyHeatmap';

type Period = 'day' | 'week' | 'month';

// TEMP: Static web version for Play Store screenshots
function WebEarningsScreen() {
  return (
    <Screen bg="dark" padded scroll>
      <View className="pt-4">
        <Text variant="h3" color="inverse" className="mb-4">Ganancias</Text>

        <View className="bg-neutral-800 rounded-2xl p-5 mb-6">
          <Text variant="caption" className="text-neutral-400 mb-1">Saldo disponible</Text>
          <Text variant="h2" className="text-white font-bold">T$ 12,450.00</Text>
          <Text variant="caption" className="text-neutral-500 mt-1">En retención: T$ 850.00</Text>
        </View>

        <View className="flex-row bg-neutral-800 rounded-xl p-1 mb-6">
          {(['Hoy', 'Semana', 'Mes'] as const).map((period, i) => (
            <Pressable key={period} className={`flex-1 py-2 rounded-lg items-center ${i === 1 ? 'bg-primary-500' : ''}`}>
              <Text variant="bodySmall" className={i === 1 ? 'text-white font-semibold' : 'text-neutral-400'}>{period}</Text>
            </Pressable>
          ))}
        </View>

        <View className="bg-neutral-800 rounded-xl p-4 mb-6">
          <Text variant="bodySmall" className="text-neutral-400 mb-3">Ganancias de la semana</Text>
          <View className="flex-row items-end justify-between h-24">
            {[45, 72, 38, 90, 65, 85, 55].map((h, i) => (
              <View key={i} className="items-center flex-1 mx-0.5">
                <View style={{ height: h, backgroundColor: i === 3 ? colors.brand.orange : '#374151', borderRadius: 4, width: '80%' }} />
                <Text variant="caption" className="text-neutral-500 mt-1 text-[10px]">{['L', 'M', 'X', 'J', 'V', 'S', 'D'][i]}</Text>
              </View>
            ))}
          </View>
        </View>

        <View className="flex-row flex-wrap gap-3 mb-6">
          {[
            { label: 'Ganancias netas', value: 'T$ 8,250.00', trend: '+12%', up: true },
            { label: 'Total viajes', value: '47', trend: '+5', up: true },
            { label: 'Promedio por viaje', value: 'T$ 175.53', trend: '-3%', up: false },
            { label: 'Calificación', value: '4.87 ★', trend: '+0.05', up: true },
          ].map((stat, i) => (
            <View key={i} className="bg-neutral-800 rounded-xl p-4" style={{ width: '48%' }}>
              <Text variant="caption" className="text-neutral-400 mb-1">{stat.label}</Text>
              <Text variant="body" className="text-white font-bold">{stat.value}</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text variant="caption" className={stat.up ? 'text-green-400' : 'text-red-400'}>{stat.trend}</Text>
                {stat.label === 'Calificación' && (
                  <Text style={{ fontSize: 11, color: colors.brand.orange }}>Ver reseñas →</Text>
                )}
              </View>
            </View>
          ))}
        </View>

        <Text variant="h4" color="inverse" className="mb-3">Rendimiento</Text>
        <View className="flex-row gap-3 mb-6">
          {[
            { label: 'Aceptación', value: '94%' },
            { label: 'Completados', value: '98%' },
            { label: 'Cancelación', value: '2%' },
          ].map((metric, i) => (
            <View key={i} className="flex-1 bg-neutral-800 rounded-xl p-3 items-center">
              <Text variant="h4" className="text-white font-bold">{metric.value}</Text>
              <Text variant="caption" className="text-neutral-400">{metric.label}</Text>
              {metric.label === 'Cancelación' && (
                <Text style={{ fontSize: 11, color: colors.brand.orange, marginTop: 4 }}>Ver penalidades →</Text>
              )}
            </View>
          ))}
        </View>
      </View>
    </Screen>
  );
}

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

// ── Earnings Goal Component ──────────────────────────────────
const GOAL_STORAGE_KEY = '@tricigo/earnings_goal';
const MILESTONE_STORAGE_PREFIX = '@tricigo/milestone_shown_';

function getTodayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function EarningsGoalCard({ currentEarnings }: { currentEarnings: number }) {
  const { t } = useTranslation('driver');
  const [goal, setGoal] = useState<number>(0);
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const shownMilestonesRef = useRef<Set<number>>(new Set());

  // Load goal from AsyncStorage
  useEffect(() => {
    AsyncStorage.getItem(GOAL_STORAGE_KEY).then((v) => {
      if (v) {
        const parsed = parseInt(v, 10);
        if (!isNaN(parsed) && parsed > 0) setGoal(parsed);
      }
    });
  }, []);

  // Load already-shown milestones for today
  useEffect(() => {
    const todayKey = getTodayKey();
    AsyncStorage.getItem(`${MILESTONE_STORAGE_PREFIX}${todayKey}`).then((v) => {
      if (v) {
        try {
          const arr = JSON.parse(v) as number[];
          shownMilestonesRef.current = new Set(arr);
        } catch { /* ignore */ }
      }
    });
  }, []);

  // Milestone toasts
  useEffect(() => {
    if (goal <= 0 || currentEarnings <= 0) return;
    const pct = (currentEarnings / goal) * 100;
    const todayKey = getTodayKey();

    const milestones: { threshold: number; message: string }[] = [
      { threshold: 25, message: t('earnings.milestone_25', { defaultValue: 'Buen inicio!' }) },
      { threshold: 50, message: t('earnings.milestone_50', { defaultValue: 'Mitad del camino!' }) },
      { threshold: 75, message: t('earnings.milestone_75', { defaultValue: 'Casi llegas!' }) },
      { threshold: 100, message: t('earnings.milestone_100', { defaultValue: 'Meta cumplida!' }) },
    ];

    for (const ms of milestones) {
      if (pct >= ms.threshold && !shownMilestonesRef.current.has(ms.threshold)) {
        shownMilestonesRef.current.add(ms.threshold);
        Toast.show({
          type: ms.threshold === 100 ? 'success' : 'info',
          text1: ms.threshold === 100 ? '🎉 ' + ms.message : ms.message,
          text2: `${Math.round(pct)}% ${t('earnings.of_goal', { defaultValue: 'de tu meta' })}`,
        });
        // Persist shown milestones for today
        AsyncStorage.setItem(
          `${MILESTONE_STORAGE_PREFIX}${todayKey}`,
          JSON.stringify(Array.from(shownMilestonesRef.current)),
        );
      }
    }
  }, [currentEarnings, goal, t]);

  const saveGoal = useCallback(() => {
    const parsed = parseInt(inputValue.replace(/\D/g, ''), 10);
    if (!isNaN(parsed) && parsed > 0) {
      setGoal(parsed);
      AsyncStorage.setItem(GOAL_STORAGE_KEY, String(parsed));
      // Reset milestones for new goal
      const todayKey = getTodayKey();
      shownMilestonesRef.current.clear();
      AsyncStorage.removeItem(`${MILESTONE_STORAGE_PREFIX}${todayKey}`);
    }
    setEditing(false);
  }, [inputValue]);

  const pct = goal > 0 ? Math.min((currentEarnings / goal) * 100, 100) : 0;
  const progressColor = pct >= 75 ? '#22c55e' : pct >= 50 ? '#eab308' : '#ef4444';

  const milestoneLabel = pct >= 100
    ? t('earnings.milestone_100', { defaultValue: 'Meta cumplida!' })
    : pct >= 75
      ? t('earnings.milestone_75', { defaultValue: 'Casi llegas!' })
      : pct >= 50
        ? t('earnings.milestone_50', { defaultValue: 'Mitad del camino!' })
        : pct >= 25
          ? t('earnings.milestone_25', { defaultValue: 'Buen inicio!' })
          : null;

  if (goal <= 0 && !editing) {
    return (
      <Pressable
        onPress={() => { setEditing(true); setInputValue(''); }}
        className="bg-neutral-800 rounded-2xl p-4 mb-4"
        accessibilityRole="button"
        accessibilityLabel={t('earnings.set_goal', { defaultValue: 'Establecer meta del dia' })}
      >
        <View className="flex-row items-center">
          <Text style={{ fontSize: 20, marginRight: 8 }}>🎯</Text>
          <Text variant="body" color="inverse" className="font-semibold">
            {t('earnings.set_goal', { defaultValue: 'Establecer meta del dia' })}
          </Text>
        </View>
        <Text variant="caption" color="inverse" className="opacity-50 mt-1">
          {t('earnings.set_goal_hint', { defaultValue: 'Define cuanto quieres ganar hoy' })}
        </Text>
      </Pressable>
    );
  }

  if (editing) {
    return (
      <View className="bg-neutral-800 rounded-2xl p-4 mb-4">
        <Text variant="body" color="inverse" className="font-semibold mb-3">
          🎯 {t('earnings.daily_goal', { defaultValue: 'Meta del dia' })} (CUP)
        </Text>
        <View className="flex-row items-center gap-3">
          <TextInput
            className="flex-1 bg-neutral-700 rounded-xl px-4 py-3 text-white text-lg"
            value={inputValue}
            onChangeText={setInputValue}
            placeholder={goal > 0 ? String(goal) : '5000'}
            placeholderTextColor="#6b7280"
            keyboardType="numeric"
            autoFocus
            onSubmitEditing={saveGoal}
            style={{ color: '#fff', fontSize: 18 }}
          />
          <Pressable
            onPress={saveGoal}
            className="bg-primary-500 rounded-xl px-5 py-3"
          >
            <Text variant="body" color="inverse" className="font-semibold">OK</Text>
          </Pressable>
          <Pressable
            onPress={() => setEditing(false)}
            className="px-3 py-3"
          >
            <Text variant="body" color="inverse" className="opacity-50">✕</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View className="bg-neutral-800 rounded-2xl p-4 mb-4">
      <View className="flex-row items-center justify-between mb-2">
        <Text variant="body" color="inverse" className="font-semibold">
          🎯 {t('earnings.daily_goal', { defaultValue: 'Meta del dia' })}: {formatCUP(goal)}
        </Text>
        {pct >= 100 && <Text style={{ fontSize: 18 }}>🎉</Text>}
      </View>

      {/* Progress bar */}
      <View
        className="h-3 bg-neutral-700 rounded-full overflow-hidden mb-2"
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: goal, now: Math.min(currentEarnings, goal) }}
      >
        <View
          className="h-full rounded-full"
          style={{ width: `${Math.round(pct)}%`, backgroundColor: progressColor }}
        />
      </View>

      <View className="flex-row items-center justify-between">
        <Text variant="bodySmall" color="inverse" className="opacity-70">
          {formatCUP(currentEarnings)} / {formatCUP(goal)} — {Math.round(pct)}% {t('earnings.completed', { defaultValue: 'completado' })}
        </Text>
      </View>

      {milestoneLabel && (
        <Text variant="caption" style={{ color: progressColor, marginTop: 4, fontWeight: '600' }}>
          {milestoneLabel}
        </Text>
      )}

      <Pressable
        onPress={() => { setEditing(true); setInputValue(String(goal)); }}
        className="mt-2"
        accessibilityRole="button"
        accessibilityLabel={t('earnings.change_goal', { defaultValue: 'Cambiar meta' })}
      >
        <Text variant="caption" className="text-primary-400">
          {t('earnings.change_goal', { defaultValue: 'Cambiar meta' })}
        </Text>
      </Pressable>
    </View>
  );
}

function NativeEarningsScreen() {
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

  const [todayEarnings, setTodayEarnings] = useState(0);
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

      const [balanceData, trips, commRateStr, ratingData] = await Promise.all([
        walletService.getBalance(userId),
        driverService.getTripHistoryByDateRange(
          driverProfileId,
          start.toISOString(),
          end.toISOString(),
        ),
        walletService.getConfigValue('commission_rate').catch(() => null),
        reviewService.getReviewSummary(userId).catch(() => null),
      ]);

      setBalance(balanceData.available);
      setPeriodTrips(trips);

      // Always compute today's earnings for goal tracking
      if (period === 'day') {
        let todayTotal = 0;
        for (const trip of trips) todayTotal += trip.final_fare_cup ?? trip.estimated_fare_cup;
        setTodayEarnings(todayTotal);
      } else {
        try {
          const todayRange = getDateRange('day');
          const todayTrips = await driverService.getTripHistoryByDateRange(
            driverProfileId, todayRange.start.toISOString(), todayRange.end.toISOString(),
          );
          let todayTotal = 0;
          for (const trip of todayTrips) todayTotal += trip.final_fare_cup ?? trip.estimated_fare_cup;
          setTodayEarnings(todayTotal);
        } catch { /* non-critical — goal card will show 0 */ }
      }

      const parsedRate = commRateStr ? parseFloat(String(commRateStr).replace(/"/g, '')) : NaN;
      setCommissionRate(!isNaN(parsedRate) && parsedRate > 0 && parsedRate < 1 ? parsedRate : 0.15);

      // Total trips (all time) — refresh profile to get latest count
      const freshProfile = await driverService.getProfile(userId).catch(() => null);
      const driverProfileData = freshProfile ?? useDriverStore.getState().profile;
      setTotalTripsCount(driverProfileData?.total_rides_completed ?? driverProfileData?.total_rides ?? 0);

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
      Toast.show({ type: 'error', text1: 'Error cargando ganancias', text2: 'Desliza para reintentar' });
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
    return Array.from(dailyData.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, val]) => ({
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
            <View className="py-4">
              <SkeletonBalance />
              <SkeletonCard lines={2} />
              <SkeletonCard lines={3} />
            </View>
          ) : (
          <>
          {/* Daily Earnings Goal */}
          <EarningsGoalCard currentEarnings={todayEarnings} />

          <AnimatedCard delay={0}>
            <BalanceBadge
              balance={balance}
              size="lg"
              className="mb-6"
            />
          </AnimatedCard>

          {/* Period Tabs */}
          <View className="flex-row gap-2 mb-4" accessibilityRole="tablist">
            {(['day', 'week', 'month'] as Period[]).map((p) => (
              <Pressable
                key={p}
                onPress={() => setPeriod(p)}
                className={`flex-1 py-3 min-h-[44px] justify-center rounded-full items-center ${
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
                <Text variant="caption" className="text-red-500 mt-0.5">
                  {t('earnings.commission_label', { defaultValue: 'Comision' })}: {formatCUP(periodStats.totalCommission)}
                </Text>
              )}
              {trendPct !== null && (
                <Text
                  variant="caption"
                  className={`mt-0.5 ${trendPct >= 0 ? 'text-green-500' : 'text-red-500'}`}
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
            <Pressable onPress={() => router.push('/profile/reviews')}>
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
                <Text variant="caption" className="text-primary-400 mt-1">
                  {t('earnings.see_reviews', { defaultValue: 'Ver reseñas →' })}
                </Text>
              </Card>
            </Pressable>
          </View>

          {/* Hourly Heatmap */}
          {periodTrips.length > 0 && (
            <HourlyHeatmap trips={periodTrips} />
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
                const langKey = i18next.language === 'en' ? 'en' : 'es';
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const qAny = q as any;
                const title = qAny[`title_${langKey}`] ?? q.title_es;
                const desc = qAny[`description_${langKey}`] ?? q.description_es;

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
                <Pressable onPress={() => router.push('/profile/penalties')} className="flex-1">
                  <Card variant="filled" padding="md" className="bg-neutral-800" accessible={true} accessibilityLabel={`${t('earnings.cancellation_rate', { defaultValue: 'Tasa cancelación' })}: ${Math.round(driverStats.cancellationRate * 100)}%`}>
                    <Text variant="caption" color="inverse" className="opacity-50">
                      {t('earnings.cancellation_rate', { defaultValue: 'Tasa cancelación' })}
                    </Text>
                    <Text variant="h4" style={{ color: driverStats.cancellationRate > 0.15 ? '#EF4444' : '#fff' }} className="mt-1">
                      {Math.round(driverStats.cancellationRate * 100)}%
                    </Text>
                    <Text variant="caption" className="text-primary-400 mt-1">
                      {t('earnings.see_penalties', { defaultValue: 'Ver penalidades →' })}
                    </Text>
                  </Card>
                </Pressable>
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

    </Screen>
  );
}

export default function EarningsScreen() {
  if (Platform.OS === 'web') return <WebEarningsScreen />;
  return <NativeEarningsScreen />;
}
