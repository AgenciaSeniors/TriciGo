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
import { EmptyState } from '@tricigo/ui/EmptyState';
import i18next from 'i18next';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { driverService } from '@tricigo/api/services/driver';
import { reviewService } from '@tricigo/api/services/review';
import { questService } from '@tricigo/api/services/quest';
import { formatCUP } from '@tricigo/utils';
import type { Ride, QuestWithProgress, LedgerTransaction } from '@tricigo/types';
import { colors, driverStandardLightColors } from '@tricigo/theme';
import { useDriverStore } from '@/stores/driver.store';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '@/stores/auth.store';
import { EarningsBarChart } from '@/components/EarningsBarChart';
import type { BarChartDataPoint } from '@/components/EarningsBarChart';
import { HourlyHeatmap } from '@/components/HourlyHeatmap';

const lt = driverStandardLightColors;
const CARD_BG = lt.card;
const BORDER_SUBTLE = lt.border.default;
const CARD_SHADOW = { shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 };

type Period = 'day' | 'week' | 'month';

type TransactionWithAmount = LedgerTransaction & {
  ledger_entries: { account_id: string; amount: number }[];
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
    <View
      className="rounded-2xl p-4 mb-4"
      style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, ...CARD_SHADOW }}
    >
      <View className="flex-row items-end justify-center" style={{ height: 120 }}>
        {entries.map(([day, val]) => {
          const height = Math.max((val.earnings / maxEarnings) * 100, 4);
          return (
            <View key={day} className="items-center mx-1" style={{ width: barWidth }}>
              <Text variant="caption" className="text-xs mb-1" style={{ color: lt.text.secondary }}>
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
              <Text variant="caption" className="text-xs mt-1" style={{ color: lt.text.tertiary }}>
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
  const prevTodayKeyRef = useRef<string>(getTodayKey());

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

    // BUG-079: Reset shown milestones when day changes
    if (todayKey !== prevTodayKeyRef.current) {
      shownMilestonesRef.current = new Set();
      prevTodayKeyRef.current = todayKey;
    }

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
    // HF-3: Validate goal bounds to prevent unreasonable values
    if (!isNaN(parsed) && parsed > 0 && parsed <= 999999) {
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
  const progressColor = pct >= 75 ? colors.success.DEFAULT : pct >= 50 ? '#eab308' : '#ef4444';

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
        className="rounded-2xl p-4 mb-4"
        style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, ...CARD_SHADOW }}
        accessibilityRole="button"
        accessibilityLabel={t('earnings.set_goal', { defaultValue: 'Establecer meta del dia' })}
      >
        <View className="flex-row items-center">
          <Text style={{ fontSize: 20, marginRight: 8 }}>🎯</Text>
          <Text variant="body" className="font-semibold" style={{ color: lt.text.primary }}>
            {t('earnings.set_goal', { defaultValue: 'Establecer meta del dia' })}
          </Text>
        </View>
        <Text variant="badge" style={{ color: lt.text.secondary }} className="mt-1">
          {t('earnings.set_goal_hint', { defaultValue: 'Define cuanto quieres ganar hoy' })}
        </Text>
      </Pressable>
    );
  }

  if (editing) {
    return (
      <View
        className="rounded-2xl p-4 mb-4"
        style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, ...CARD_SHADOW }}
      >
        <Text variant="body" className="font-semibold mb-3" style={{ color: lt.text.primary }}>
          🎯 {t('earnings.daily_goal', { defaultValue: 'Meta del dia' })} (CUP)
        </Text>
        <View className="flex-row items-center gap-3">
          <TextInput
            className="flex-1 rounded-xl px-4 py-3 text-lg"
            style={{ backgroundColor: lt.background.tertiary, color: lt.text.primary, fontSize: 18, borderWidth: 1, borderColor: lt.border.default }}
            value={inputValue}
            onChangeText={setInputValue}
            placeholder={goal > 0 ? String(goal) : '5000'}
            placeholderTextColor={lt.text.tertiary}
            keyboardType="numeric"
            autoFocus
            onSubmitEditing={saveGoal}
            accessibilityLabel={t('earnings.goal_input', { defaultValue: 'Monto de meta diaria' })}
          />
          <Pressable
            onPress={saveGoal}
            className="bg-primary-500 rounded-xl px-5 min-h-[48px] justify-center"
            accessibilityRole="button"
            accessibilityLabel={t('earnings.save_goal', { defaultValue: 'Guardar meta' })}
          >
            <Text variant="body" color="inverse" className="font-semibold">OK</Text>
          </Pressable>
          <Pressable
            onPress={() => setEditing(false)}
            className="px-3 min-h-[48px] justify-center"
            accessibilityRole="button"
            accessibilityLabel={t('earnings.cancel', { defaultValue: 'Cancelar' })}
          >
            <Text variant="body" style={{ color: lt.text.tertiary }}>✕</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View
      className="rounded-2xl p-4 mb-4"
      style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, ...CARD_SHADOW }}
    >
      <View className="flex-row items-center justify-between mb-2">
        <Text variant="body" className="font-semibold" style={{ color: lt.text.primary }}>
          🎯 {t('earnings.daily_goal', { defaultValue: 'Meta del dia' })}: {formatCUP(goal)}
        </Text>
        {pct >= 100 && <Text style={{ fontSize: 18 }}>🎉</Text>}
      </View>

      {/* Progress bar */}
      <View
        className="h-3 rounded-full overflow-hidden mb-2"
        style={{ backgroundColor: lt.border.subtle }}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: goal, now: Math.min(currentEarnings, goal) }}
      >
        <View
          className="h-full rounded-full"
          style={{ width: `${Math.round(pct)}%`, backgroundColor: progressColor }}
        />
      </View>

      <View className="flex-row items-center justify-between">
        <Text variant="bodySmall" style={{ color: lt.text.secondary }}>
          {formatCUP(currentEarnings)} / {formatCUP(goal)} — {Math.round(pct)}% {t('earnings.completed', { defaultValue: 'completado' })}
        </Text>
      </View>

      {milestoneLabel && (
        <Text variant="badge" style={{ color: progressColor, marginTop: 4, fontWeight: '600' }}>
          {milestoneLabel}
        </Text>
      )}

      <Pressable
        onPress={() => { setEditing(true); setInputValue(String(goal)); }}
        className="mt-2 min-h-[48px] justify-center"
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

  // Recent activity (wallet transactions)
  const [transactions, setTransactions] = useState<TransactionWithAmount[]>([]);
  const [txPage, setTxPage] = useState(0);
  const [txHasMore, setTxHasMore] = useState(true);
  const [txLoading, setTxLoading] = useState(false);
  const [txExpanded, setTxExpanded] = useState(false);

  const fetchData = useCallback(async () => {
    if (!userId || !driverProfileId) return;
    try {
      const { start, end } = getDateRange(period);

      // Critical data — fetch in parallel (4 calls → renders immediately)
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

      // Today's earnings — filter from existing data instead of a second API call
      if (period === 'day') {
        let todayTotal = 0;
        for (const trip of trips) todayTotal += trip.final_fare_cup ?? trip.estimated_fare_cup;
        setTodayEarnings(todayTotal);
      } else {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        let todayTotal = 0;
        for (const trip of trips) {
          const completedAt = new Date(trip.completed_at ?? trip.created_at);
          if (completedAt >= todayStart) {
            todayTotal += trip.final_fare_cup ?? trip.estimated_fare_cup;
          }
        }
        setTodayEarnings(todayTotal);
      }

      const parsedRate = commRateStr ? parseFloat(String(commRateStr).replace(/"/g, '')) : NaN;
      setCommissionRate(!isNaN(parsedRate) && parsedRate > 0 && parsedRate < 1 ? parsedRate : 0.15);

      // Total trips — use cached profile from store (no extra API call)
      const driverProfileData = useDriverStore.getState().profile;
      setTotalTripsCount(driverProfileData?.total_rides_completed ?? driverProfileData?.total_rides ?? 0);

      if (ratingData) {
        setAvgRating(ratingData.average_rating);
        setTotalReviews(ratingData.total_reviews);
      }
    } catch (err) {
      console.error('Error fetching earnings:', err);
      Toast.show({ type: 'error', text1: 'Error cargando ganancias', text2: 'Desliza para reintentar' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }

    // Non-critical data — deferred (doesn't block initial render)
    try {
      const [questData, stats] = await Promise.all([
        questService.getDriverQuestProgress(driverProfileId).catch(() => null),
        driverService.getDriverStats(driverProfileId).catch(() => null),
      ]);
      if (questData) setQuests(questData);
      if (stats) setDriverStats(stats);
    } catch { /* non-critical */ }

    // Previous period for trend comparison — deferred
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
  }, [userId, driverProfileId, period]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    // Reset transactions on refresh
    setTransactions([]);
    setTxPage(0);
    setTxHasMore(true);
    fetchData();
  }, [fetchData]);

  const loadTransactions = useCallback(async () => {
    if (!userId || txLoading) return;
    setTxLoading(true);
    try {
      const account = await walletService.getAccount(userId);
      if (!account) return;
      const data = await walletService.getTransactions(account.id, txPage, 10);
      if (data.length < 10) setTxHasMore(false);
      setTransactions(prev => txPage === 0 ? (data as TransactionWithAmount[]) : [...prev, ...(data as TransactionWithAmount[])]);
    } catch {
      // silent fail — non-critical
    } finally {
      setTxLoading(false);
    }
  }, [userId, txPage, txLoading]);

  // Load transactions when section is expanded or page changes
  useEffect(() => {
    if (txExpanded) {
      loadTransactions();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txExpanded, txPage]);

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

  // Check if there is no earnings data at all
  const hasNoEarningsData = !loading && periodStats.totalEarnings === 0 && periodStats.completedCount === 0;

  return (
    <Screen bg="lightPrimary" statusBarStyle="dark-content">
      <ScrollView
        className="flex-1 px-5"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.brand.orange}
            accessibilityLabel={t('earnings.refresh', { defaultValue: 'Actualizar ganancias' })}
          />
        }
      >
        <View className="pt-4 pb-8">
          <Text variant="h3" style={{ color: lt.text.primary }} className="mb-4">
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
            <Pressable
              onPress={() => router.push('/wallet')}
              accessibilityRole="button"
              accessibilityLabel={t('wallet.open', { defaultValue: 'Abrir Wallet' })}
            >
              <BalanceBadge
                balance={balance}
                size="lg"
                className="mb-2"
              />
              <View className="flex-row items-center justify-center mb-4">
                <Ionicons name="wallet-outline" size={14} color={colors.brand.orange} />
                <Text variant="caption" color="accent" className="ml-1">
                  {t('wallet.open', { defaultValue: 'Ver Wallet' })}
                </Text>
                <Ionicons name="chevron-forward" size={12} color={colors.brand.orange} />
              </View>
            </Pressable>
          </AnimatedCard>

          {/* Period Tabs */}
          <View className="flex-row gap-2 mb-4" accessibilityRole="tablist">
            {(['day', 'week', 'month'] as Period[]).map((p) => (
              <Pressable
                key={p}
                onPress={() => setPeriod(p)}
                className="flex-1 min-h-[48px] justify-center rounded-full items-center"
                style={period === p
                  ? { backgroundColor: '#FF4D00' }
                  : { backgroundColor: lt.background.tertiary }
                }
                accessibilityRole="tab"
                accessibilityState={{ selected: period === p }}
                accessibilityLabel={periodLabels[p]}
              >
                <Text
                  variant="bodySmall"
                  className="font-semibold"
                  style={{ color: period === p ? '#FFFFFF' : lt.text.secondary }}
                >
                  {periodLabels[p]}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Empty state when no earnings data */}
          {hasNoEarningsData ? (
            <EmptyState
              icon="wallet-outline"
              title={t('earnings.no_earnings_title', { defaultValue: 'Sin ganancias' })}
              description={t('earnings.no_earnings_yet', { defaultValue: 'Aún no tienes ganancias en este periodo. Completa viajes para ver tus estadísticas aquí.' })}
            />
          ) : (
          <>
          {/* Bar Chart (SVG) */}
          {period !== 'day' && chartData.length > 0 && (
            <EarningsBarChart data={chartData} theme="light" />
          )}

          {/* Period Stats */}
          <View className="flex-row gap-3 mb-2">
            <Card
              variant="filled"
              padding="md"
              className="flex-1"
              style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
            >
              <Text variant="badge" style={{ color: lt.text.secondary }}>
                {t('earnings.net_today', { defaultValue: 'Ganancia neta' })}
              </Text>
              <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
                {formatCUP(periodStats.netEarnings)}
              </Text>
              {periodStats.totalCommission > 0 && (
                <Text variant="badge" style={{ color: '#EF4444' }} className="mt-0.5">
                  {t('earnings.commission_label', { defaultValue: 'Comision' })}: {formatCUP(periodStats.totalCommission)}
                </Text>
              )}
              {trendPct !== null && (
                <Text
                  variant="badge"
                  style={{ color: trendPct >= 0 ? colors.success.DEFAULT : '#EF4444' }}
                  className="mt-0.5"
                >
                  {trendPct >= 0
                    ? t('earnings.trend_up', { pct: trendPct, defaultValue: `+${trendPct}% vs anterior` })
                    : t('earnings.trend_down', { pct: Math.abs(trendPct), defaultValue: `${trendPct}% vs anterior` })}
                </Text>
              )}
            </Card>
            <Card
              variant="filled"
              padding="md"
              className="flex-1"
              style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
            >
              <Text variant="badge" style={{ color: lt.text.secondary }}>
                {t('earnings.total_trips')}
              </Text>
              <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
                {periodStats.completedCount}
              </Text>
            </Card>
          </View>

          {/* Avg per trip */}
          <View className="flex-row gap-3 mb-4">
            <Card
              variant="filled"
              padding="md"
              className="flex-1"
              style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
            >
              <Text variant="badge" style={{ color: lt.text.secondary }}>
                {t('earnings.avg_per_trip', { defaultValue: 'Promedio por viaje' })}
              </Text>
              <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
                {formatCUP(periodStats.avgPerTrip)}
              </Text>
            </Card>
            <Pressable
              onPress={() => router.push('/profile/reviews')}
              accessibilityRole="button"
              accessibilityLabel={t('earnings.see_reviews', { defaultValue: 'Ver reseñas' })}
            >
              <Card
                variant="filled"
                padding="md"
                className="flex-1"
                style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
              >
                <Text variant="badge" style={{ color: lt.text.secondary }}>
                  {t('earnings.rating')}
                </Text>
                <View className="flex-row items-center mt-1">
                  <Text variant="metric" style={{ color: lt.text.primary }} className="mr-1">
                    {avgRating != null ? `★ ${avgRating.toFixed(1)}` : '★ —'}
                  </Text>
                  {totalReviews > 0 && (
                    <Text variant="badge" style={{ color: lt.text.secondary }}>
                      ({totalReviews})
                    </Text>
                  )}
                </View>
                <Text variant="badge" style={{ color: colors.brand.orange }} className="mt-1">
                  {t('earnings.see_reviews', { defaultValue: 'Ver reseñas →' })}
                </Text>
              </Card>
            </Pressable>
          </View>

          {/* Hourly Heatmap */}
          {periodTrips.length > 0 && (
            <HourlyHeatmap trips={periodTrips} theme="light" />
          )}

          {/* Quests / Missions */}
          <View className="mt-8">
            <Text variant="h4" style={{ color: lt.text.primary }} className="mb-3">
              {t('earnings.quests_title', { defaultValue: 'Misiones' })}
            </Text>
            {quests.length === 0 ? (
              <Text variant="bodySmall" style={{ color: lt.text.tertiary }}>
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
                  <Card
                    key={q.id}
                    variant="filled"
                    padding="md"
                    className="mb-3"
                    style={{
                      backgroundColor: isCompleted ? 'rgba(34,197,94,0.08)' : CARD_BG,
                      borderWidth: 1,
                      borderColor: isCompleted ? 'rgba(34,197,94,0.2)' : BORDER_SUBTLE,
                      borderRadius: 16,
                      ...CARD_SHADOW,
                    }}
                  >
                    <View className="flex-row items-center justify-between mb-1">
                      <Text variant="body" className="font-semibold flex-1 mr-2" style={{ color: lt.text.primary }}>
                        {isCompleted ? '✅ ' : ''}{title}
                      </Text>
                      <Text variant="badge" style={{ color: colors.brand.orange, fontWeight: '700' }}>
                        +{formatCUP(q.reward_cup)}
                      </Text>
                    </View>
                    <Text variant="caption" style={{ color: lt.text.secondary }} className="mb-2">
                      {desc}
                    </Text>
                    {/* Progress bar */}
                    <View
                      className="h-2 rounded-full overflow-hidden mb-1"
                      style={{ backgroundColor: lt.border.subtle }}
                      accessibilityRole="progressbar"
                      accessibilityValue={{ min: 0, max: q.target_value, now: current }}
                    >
                      <View
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.round(progress * 100)}%`,
                          backgroundColor: isCompleted ? colors.success.DEFAULT : colors.brand.orange,
                        }}
                      />
                    </View>
                    <Text variant="badge" style={{ color: lt.text.secondary }}>
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
              <Text variant="h4" style={{ color: lt.text.primary }} className="mb-3">
                {t('earnings.performance_title', { defaultValue: 'Rendimiento' })}
              </Text>
              <View className="flex-row gap-3 mb-3">
                <Card
                  variant="filled"
                  padding="md"
                  className="flex-1"
                  style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
                  accessible={true}
                  accessibilityLabel={`${t('earnings.acceptance_rate', { defaultValue: 'Tasa aceptación' })}: ${Math.round(driverStats.acceptanceRate * 100)}%`}
                >
                  <Text variant="badge" style={{ color: lt.text.secondary }}>
                    {t('earnings.acceptance_rate', { defaultValue: 'Tasa aceptación' })}
                  </Text>
                  <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
                    {Math.round(driverStats.acceptanceRate * 100)}%
                  </Text>
                </Card>
                <Card
                  variant="filled"
                  padding="md"
                  className="flex-1"
                  style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
                  accessible={true}
                  accessibilityLabel={`${t('earnings.completion_rate', { defaultValue: 'Tasa completado' })}: ${Math.round(driverStats.completionRate * 100)}%`}
                >
                  <Text variant="badge" style={{ color: lt.text.secondary }}>
                    {t('earnings.completion_rate', { defaultValue: 'Tasa completado' })}
                  </Text>
                  <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
                    {Math.round(driverStats.completionRate * 100)}%
                  </Text>
                </Card>
              </View>
              <View className="flex-row gap-3 mb-3">
                <Pressable
                  onPress={() => router.push('/profile/penalties')}
                  className="flex-1"
                  accessibilityRole="button"
                  accessibilityLabel={t('earnings.see_penalties', { defaultValue: 'Ver penalidades' })}
                >
                  <Card
                    variant="filled"
                    padding="md"
                    style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
                    accessible={true}
                    accessibilityLabel={`${t('earnings.cancellation_rate', { defaultValue: 'Tasa cancelación' })}: ${Math.round(driverStats.cancellationRate * 100)}%`}
                  >
                    <Text variant="badge" style={{ color: lt.text.secondary }}>
                      {t('earnings.cancellation_rate', { defaultValue: 'Tasa cancelación' })}
                    </Text>
                    <Text variant="metric" style={{ color: driverStats.cancellationRate > 0.15 ? '#EF4444' : lt.text.primary }} className="mt-1">
                      {Math.round(driverStats.cancellationRate * 100)}%
                    </Text>
                    <Text variant="badge" style={{ color: colors.brand.orange }} className="mt-1">
                      {t('earnings.see_penalties', { defaultValue: 'Ver penalidades →' })}
                    </Text>
                  </Card>
                </Pressable>
                <Card
                  variant="filled"
                  padding="md"
                  className="flex-1"
                  style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
                  accessible={true}
                  accessibilityLabel={`${t('earnings.avg_response_time', { defaultValue: 'Tiempo respuesta' })}: ${driverStats.avgResponseTimeS != null ? `${driverStats.avgResponseTimeS}s` : '—'}`}
                >
                  <Text variant="badge" style={{ color: lt.text.secondary }}>
                    {t('earnings.avg_response_time', { defaultValue: 'Tiempo respuesta' })}
                  </Text>
                  <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
                    {driverStats.avgResponseTimeS != null ? `${driverStats.avgResponseTimeS}s` : '—'}
                  </Text>
                </Card>
              </View>
              <View className="flex-row gap-3">
                <Card
                  variant="filled"
                  padding="md"
                  className="flex-1"
                  style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
                  accessible={true}
                  accessibilityLabel={`${t('earnings.rides_this_week', { defaultValue: 'Esta semana' })}: ${driverStats.ridesThisWeek}`}
                >
                  <Text variant="badge" style={{ color: lt.text.secondary }}>
                    {t('earnings.rides_this_week', { defaultValue: 'Esta semana' })}
                  </Text>
                  <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
                    {driverStats.ridesThisWeek}
                  </Text>
                </Card>
                <Card
                  variant="filled"
                  padding="md"
                  className="flex-1"
                  style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
                  accessible={true}
                  accessibilityLabel={`${t('earnings.match_score', { defaultValue: 'Puntuación' })}: ${driverStats.matchScore}`}
                >
                  <Text variant="badge" style={{ color: lt.text.secondary }}>
                    {t('earnings.match_score', { defaultValue: 'Puntuación' })}
                  </Text>
                  <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
                    {driverStats.matchScore}
                  </Text>
                </Card>
              </View>
            </View>
          )}

          {/* Recent Wallet Activity */}
          <View className="mt-8 mb-4">
            <Card
              variant="filled"
              padding="md"
              style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
            >
              <Pressable
                onPress={() => setTxExpanded(!txExpanded)}
                className="flex-row items-center justify-between min-h-[48px]"
                accessibilityRole="button"
                accessibilityLabel={t('earnings.recent_activity', { defaultValue: 'Actividad reciente' })}
                accessibilityState={{ expanded: txExpanded }}
              >
                <View className="flex-row items-center">
                  <Ionicons name="receipt-outline" size={18} color={colors.brand.orange} />
                  <Text variant="body" className="ml-2 font-semibold" style={{ color: lt.text.primary }}>
                    {t('earnings.recent_activity', { defaultValue: 'Actividad reciente' })}
                  </Text>
                </View>
                <Ionicons name={txExpanded ? 'chevron-up' : 'chevron-down'} size={18} color={lt.text.secondary} />
              </Pressable>

              {txExpanded && (
                <View className="mt-3">
                  {transactions.length === 0 && !txLoading && (
                    <Text variant="bodySmall" style={{ color: lt.text.secondary }} className="text-center py-4">
                      {t('earnings.no_transactions', { defaultValue: 'No hay transacciones recientes' })}
                    </Text>
                  )}
                  {transactions.map((tx) => {
                    const amount = tx.ledger_entries?.[0]?.amount ?? 0;
                    const isCredit = amount > 0;
                    return (
                      <View
                        key={tx.id}
                        className="flex-row items-center py-2"
                        style={{ borderBottomWidth: 1, borderBottomColor: BORDER_SUBTLE }}
                      >
                        <Ionicons
                          name={
                            tx.type === 'recharge' ? 'add-circle' :
                            tx.type === 'ride_payment' ? 'car' :
                            tx.type === 'commission' ? 'cut' :
                            tx.type === 'transfer_in' ? 'arrow-down-circle' :
                            tx.type === 'transfer_out' ? 'arrow-up-circle' :
                            tx.type === 'promo_credit' ? 'gift' :
                            tx.type === 'redemption' ? 'wallet' :
                            'swap-horizontal'
                          }
                          size={16}
                          color={isCredit ? colors.success.DEFAULT : '#EF4444'}
                        />
                        <View className="flex-1 ml-2">
                          <Text variant="bodySmall" style={{ color: lt.text.primary }}>
                            {t(`earnings.tx_${tx.type}`, { defaultValue: tx.type })}
                          </Text>
                          <Text variant="badge" style={{ color: lt.text.secondary }}>
                            {new Date(tx.created_at).toLocaleDateString()}
                          </Text>
                        </View>
                        <Text variant="bodySmall" style={{ color: isCredit ? colors.success.DEFAULT : '#EF4444', fontWeight: '600' }}>
                          {isCredit ? '+' : ''}{formatCUP(amount)}
                        </Text>
                      </View>
                    );
                  })}
                  {txHasMore && transactions.length > 0 && (
                    <Pressable
                      onPress={() => setTxPage(p => p + 1)}
                      className="py-3 items-center min-h-[48px] justify-center"
                      accessibilityRole="button"
                      accessibilityLabel={t('earnings.view_more', { defaultValue: 'Ver mas' })}
                    >
                      <Text variant="bodySmall" style={{ color: colors.brand.orange }}>
                        {txLoading ? '...' : t('earnings.view_more', { defaultValue: 'Ver mas' })}
                      </Text>
                    </Pressable>
                  )}
                  {txLoading && transactions.length === 0 && (
                    <ActivityIndicator size="small" color={colors.brand.orange} className="py-4" />
                  )}
                </View>
              )}
            </Card>
          </View>
          </>
          )}
          </>
          )}
        </View>
      </ScrollView>

    </Screen>
  );
}

export default function EarningsScreen() {
  return <NativeEarningsScreen />;
}
