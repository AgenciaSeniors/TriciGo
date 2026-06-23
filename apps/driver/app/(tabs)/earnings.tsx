/**
 * Earnings dashboard — orchestrator.
 *
 * Cuban Modern wrapper + hero card + stagger entrance (PR post-#232).
 * Subcomponents internos (charts, heatmaps, quests, performance, activity)
 * SIGUEN usando midnightEmber tokens — se ven consistentes dentro de su
 * propia card sobre el paper Cuban. NO se refactoriza el midnightEmber
 * en este PR (decisión user: "Wrapper + Hero + Stagger" scope).
 *
 *   Subcomponents (intactos, midnightEmber):
 *     - EarningsHeader (sin uso ahora — reemplazado por hero card Cuban)
 *     - PeriodTabs                — Hoy / Semana / Mes pill row
 *     - EarningsGoalCard          — daily goal + milestone toasts
 *     - EarningsStatsCards        — 6 stat cards (3 × 2)
 *     - PerformanceMetricsSection — driver KPIs (acceptance, etc.)
 *     - QuestsSection             — quest progress list
 *     - RecentActivitySection     — collapsible txn list
 *
 *   Charts/Heatmaps (intactos, midnightEmber):
 *     - EarningsBarChart, HourlyHeatmap, PersonalPeakHours, EarningsByZoneChart
 *
 *   Hook (intacto):
 *     - useEarningsData — fetch (critical / deferred / trend / tx pagination)
 */
import React, { useMemo, useState, useRef, useEffect } from 'react';
import {
  View,
  ScrollView,
  RefreshControl,
  Animated,
  Easing,
  StyleSheet,
  useColorScheme,
} from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { useTranslation } from '@tricigo/i18n';
import { cubanLight, cubanDark, colors, midnightEmber } from '@tricigo/theme';
import { formatCUP, formatUSD, trcToUsd, DEFAULT_EXCHANGE_RATE } from '@tricigo/utils';
import type { Ride } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { EarningsBarChart } from '@/components/EarningsBarChart';
import type { BarChartDataPoint } from '@/components/EarningsBarChart';
import { HourlyHeatmap } from '@/components/HourlyHeatmap';
import { PersonalPeakHours } from '@/components/earnings/PersonalPeakHours';
import { useDriverPeakHours } from '@/hooks/useDriverPeakHours';
import { EarningsByZoneChart } from '@/components/EarningsByZoneChart';
import { useDriverEarningsByZone } from '@/hooks/useDriverEarningsByZone';
import { useEarningsData, getDateRange, type Period } from '@/hooks/useEarningsData';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import { tripNetEarnings } from '@/utils/tripNetEarnings';
import { PeriodTabs } from '@/components/earnings/PeriodTabs';
import { EarningsGoalCard } from '@/components/earnings/EarningsGoalCard';
import { EarningsStatsCards } from '@/components/earnings/EarningsStatsCards';
import { PerformanceMetricsSection } from '@/components/earnings/PerformanceMetricsSection';
import { QuestsSection } from '@/components/earnings/QuestsSection';
import { RecentActivitySection } from '@/components/earnings/RecentActivitySection';

// Tabular-nums style for number alignment
const TABULAR: { fontVariant: ('tabular-nums')[] } = { fontVariant: ['tabular-nums'] };

/**
 * Aggregate completed trips by day for the bar chart. NET earnings per
 * day (fare − commission + tip) matches the headline totals.
 */
function groupTripsByDay(
  trips: Ride[],
  commissionRate: number,
): Map<string, { earnings: number; count: number }> {
  const grouped = new Map<string, { earnings: number; count: number }>();
  for (const trip of trips) {
    const dateKey = new Date(trip.completed_at ?? trip.created_at).toLocaleDateString('es-CU', {
      day: '2-digit',
      month: '2-digit',
    });
    const existing = grouped.get(dateKey) ?? { earnings: 0, count: 0 };
    existing.earnings += tripNetEarnings(trip, commissionRate);
    existing.count += 1;
    grouped.set(dateKey, existing);
  }
  return grouped;
}

function NativeEarningsScreen() {
  const { t } = useTranslation('driver');
  const userId = useAuthStore((s) => s.user?.id);
  const driverProfileId = useDriverStore((s) => s.profile?.id);

  // Cuban Modern palette — warm cream / navy profundo
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;

  const HERO_SHADOW = {
    shadowColor: '#FF4D00',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: isDark ? 0.28 : 0.16,
    shadowRadius: 24,
    elevation: 12,
  };

  const [period, setPeriod] = useState<Period>('day');
  const [txExpanded, setTxExpanded] = useState(false);

  // N2 — personal peak hours
  const { data: peakHours, loading: peakHoursLoading } = useDriverPeakHours({
    driverId: driverProfileId,
    days: 30,
    enabled: !!driverProfileId,
  });

  const {
    loading,
    refreshing,
    periodTrips,
    commissionRate,
    avgRating,
    totalReviews,
    todayEarnings,
    prevPeriodEarnings,
    quests,
    driverStats,
    transactions,
    txAccountId,
    txHasMore,
    txLoading,
    loadMoreTransactions,
    refetch,
  } = useEarningsData({
    userId,
    driverProfileId,
    period,
    txExpanded,
  });

  // Tabs don't unmount in Expo: refresh earnings when the tab regains focus
  // (and when the app returns from background), so a just-completed trip shows
  // up without a manual pull-to-refresh. `refetch` is stable (useCallback).
  useRefreshOnFocus(refetch);

  // Per-period stats derived from the trips list.
  const periodStats = useMemo(() => {
    let totalEarnings = 0;
    let totalCommission = 0;
    let completedCount = 0;
    let totalDurationSec = 0;

    for (const trip of periodTrips) {
      const fare = trip.final_fare_cup ?? trip.estimated_fare_cup;
      totalEarnings += fare;
      const serverCommission = (trip as Ride & { commission_amount?: number | null }).commission_amount;
      totalCommission += serverCommission != null
        ? serverCommission
        : Math.round(fare * commissionRate);
      completedCount++;
      totalDurationSec += trip.actual_duration_s ?? trip.estimated_duration_s ?? 0;
    }

    const avgPerTrip = completedCount > 0 ? Math.round(totalEarnings / completedCount) : 0;
    const netEarnings = totalEarnings - totalCommission;
    const totalHours = totalDurationSec / 3600;
    const ridesPerHour = totalHours > 0 ? completedCount / totalHours : 0;
    const earningsPerHour = totalHours > 0 ? Math.round(netEarnings / totalHours) : 0;

    return {
      totalEarnings,
      totalCommission,
      netEarnings,
      completedCount,
      avgPerTrip,
      totalHours,
      ridesPerHour,
      earningsPerHour,
    };
  }, [periodTrips, commissionRate]);

  const periodRange = useMemo(() => getDateRange(period), [period]);
  const { data: earningsByZone, loading: earningsByZoneLoading } = useDriverEarningsByZone({
    driverId: driverProfileId ?? null,
    start: periodRange.start,
    end: periodRange.end,
    enabled: !!driverProfileId,
  });

  const chartData: BarChartDataPoint[] = useMemo(() => {
    const dailyData = groupTripsByDay(periodTrips, commissionRate);
    const today = new Date().toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit' });
    return Array.from(dailyData.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, val]) => ({
        label,
        value: val.earnings,
        isToday: label === today,
      }));
  }, [periodTrips, commissionRate]);

  const trendPct = useMemo(() => {
    if (prevPeriodEarnings == null || prevPeriodEarnings === 0) return null;
    // #2 (audit 2026-06-04): comparar NET vs NET. El hero muestra netEarnings y
    // prevPeriodEarnings ya es net (suma de tripNetEarnings); antes usaba
    // totalEarnings (BRUTO) → la tendencia no coincidía con el número mostrado.
    return Math.round(((periodStats.netEarnings - prevPeriodEarnings) / prevPeriodEarnings) * 100);
  }, [periodStats.netEarnings, prevPeriodEarnings]);

  const hasNoEarningsData =
    !loading && periodStats.totalEarnings === 0 && periodStats.completedCount === 0;

  // ── Stagger entrance — 5 sections ──────────────────────────────────
  const fadeAnim = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;
  useEffect(() => {
    if (!loading) {
      Animated.stagger(
        80,
        fadeAnim.map((a) =>
          Animated.timing(a, {
            toValue: 1,
            duration: 380,
            useNativeDriver: true,
            easing: Easing.out(Easing.cubic),
          }),
        ),
      ).start();
    }
  }, [loading, fadeAnim]);

  const sectionTranslateY = (idx: number) =>
    fadeAnim[idx]!.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });

  const sectionStyle = (idx: number) => ({
    opacity: fadeAnim[idx]!,
    transform: [{ translateY: sectionTranslateY(idx) }],
  });

  // ── Hero copy by period ────────────────────────────────────────────
  const heroLabel =
    period === 'day'
      ? t('earnings.hero_today', { defaultValue: 'Ganaste hoy' })
      : period === 'week'
        ? t('earnings.hero_week', { defaultValue: 'Ganaste esta semana' })
        : t('earnings.hero_month', { defaultValue: 'Ganaste este mes' });

  const tripsCountLabel =
    periodStats.completedCount === 1
      ? t('earnings.hero_one_trip', { defaultValue: '1 viaje' })
      : t('earnings.hero_n_trips', {
          defaultValue: '{{count}} viajes',
          count: periodStats.completedCount,
        });

  return (
    <Screen bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'}>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refetch}
              tintColor={colors.brand.orange}
              accessibilityLabel={t('earnings.refresh', { defaultValue: 'Actualizar ganancias' })}
            />
          }
        >
          {/* ── Hero Earnings Card ─────────────────────────────────── */}
          <Animated.View style={[sectionStyle(0), { borderRadius: 24, overflow: 'hidden', marginBottom: 18, ...HERO_SHADOW }]}>
            {/* Layer 1: base gradient */}
            <LinearGradient
              colors={isDark ? ['#11172A', '#18203A'] : ['#FFFFFF', '#FFFBF5']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFillObject}
            />
            {/* Layer 2: orange glow corner */}
            <LinearGradient
              colors={[palette.accent.orangeGlow, 'transparent']}
              start={{ x: 1, y: 0 }}
              end={{ x: 0.3, y: 0.7 }}
              style={{ position: 'absolute', top: 0, right: 0, width: 180, height: 180 }}
              pointerEvents="none"
            />
            {/* Layer 3: content */}
            <View style={{ padding: 24 }}>
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 1.6,
                  color: palette.ink.secondary,
                  textTransform: 'uppercase',
                  marginBottom: 10,
                }}
              >
                {heroLabel}
              </Text>
              <Text
                style={{
                  fontFamily: 'Inter_800ExtraBold',
                  fontSize: 42,
                  letterSpacing: -1.2,
                  lineHeight: 48,
                  color: palette.ink.primary,
                  ...TABULAR,
                }}
                numberOfLines={1}
                adjustsFontSizeToFit
              >
                {loading ? '—' : formatCUP(periodStats.netEarnings)}
              </Text>
              {!loading && (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: palette.accent.warm,
                      marginRight: 8,
                    }}
                  />
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '600',
                      color: palette.accent.warm,
                      ...TABULAR,
                    }}
                  >
                    {tripsCountLabel} · ≈ {formatUSD(trcToUsd(periodStats.netEarnings, DEFAULT_EXCHANGE_RATE))}
                  </Text>
                </View>
              )}
              {/* Trend indicator — pill if trendPct available */}
              {!loading && trendPct != null && (
                <View
                  style={{
                    marginTop: 14,
                    alignSelf: 'flex-start',
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: trendPct >= 0 ? '#22C55E22' : '#EF444422',
                    borderRadius: 9999,
                    paddingHorizontal: 12,
                    paddingVertical: 5,
                  }}
                >
                  <Text style={{ color: trendPct >= 0 ? '#16A34A' : '#DC2626', fontSize: 12, fontWeight: '700', marginRight: 4 }}>
                    {trendPct >= 0 ? '↑' : '↓'}
                  </Text>
                  <Text style={{ color: trendPct >= 0 ? '#16A34A' : '#DC2626', fontSize: 12, fontWeight: '700', ...TABULAR }}>
                    {Math.abs(trendPct)}% {t('earnings.vs_prev_period', { defaultValue: 'vs período anterior' })}
                  </Text>
                </View>
              )}
            </View>
          </Animated.View>

          {loading ? (
            // Light skeleton — let the hero "—" hold space while sections load
            <View style={{ marginTop: 8 }}>
              <View style={{ height: 120, borderRadius: 18, backgroundColor: palette.bg.elev1, marginBottom: 14 }} />
              <View style={{ height: 60, borderRadius: 16, backgroundColor: palette.bg.elev1, marginBottom: 14 }} />
              <View style={{ height: 180, borderRadius: 18, backgroundColor: palette.bg.elev1 }} />
            </View>
          ) : (
            <>
              {/* ── Daily Goal ───────────────────────────────────── */}
              <Animated.View style={sectionStyle(1)}>
                <EarningsGoalCard currentEarnings={todayEarnings} />
              </Animated.View>

              {/* ── Period Tabs ──────────────────────────────────── */}
              <Animated.View style={sectionStyle(2)}>
                <PeriodTabs period={period} onChange={setPeriod} />
              </Animated.View>

              {/* ── Charts + Stats ───────────────────────────────── */}
              <Animated.View style={sectionStyle(3)}>
                {hasNoEarningsData ? (
                  <EmptyState
                    icon="wallet-outline"
                    title={
                      period === 'day'
                        ? t('earnings.no_earnings_today_title', { defaultValue: 'Aún sin ganancias hoy' })
                        : period === 'week'
                          ? t('earnings.no_earnings_week_title', { defaultValue: 'Aún sin ganancias esta semana' })
                          : t('earnings.no_earnings_month_title', { defaultValue: 'Aún sin ganancias este mes' })
                    }
                    description={t('earnings.no_earnings_cta_description', {
                      defaultValue: 'Conectate para empezar a recibir ofertas. Tus ganancias aparecen acá al completar el primer viaje.',
                    })}
                    action={{
                      label: t('earnings.go_online_cta', { defaultValue: 'Ir a Inicio' }),
                      onPress: () => router.push('/(tabs)'),
                    }}
                  />
                ) : (
                  <>
                    {period !== 'day' && chartData.length > 0 && (
                      <EarningsBarChart data={chartData} theme={isDark ? 'dark' : 'light'} />
                    )}
                    <EarningsStatsCards
                      stats={periodStats}
                      trendPct={trendPct}
                      avgRating={avgRating}
                      totalReviews={totalReviews}
                      period={period}
                    />
                    {periodTrips.length > 0 && (
                      <HourlyHeatmap trips={periodTrips} theme={isDark ? 'dark' : 'light'} />
                    )}
                    <PersonalPeakHours data={peakHours} loading={peakHoursLoading} />
                    <EarningsByZoneChart data={earningsByZone} loading={earningsByZoneLoading} />
                  </>
                )}
              </Animated.View>

              {/* ── Quests + Performance + Activity ──────────────── */}
              {!hasNoEarningsData && (
                <Animated.View style={sectionStyle(4)}>
                  <QuestsSection quests={quests} />
                  <PerformanceMetricsSection stats={driverStats} />
                  <RecentActivitySection
                    transactions={transactions}
                    accountId={txAccountId}
                    loading={txLoading}
                    hasMore={txHasMore}
                    onLoadMore={loadMoreTransactions}
                    onExpandedChange={setTxExpanded}
                  />
                </Animated.View>
              )}
            </>
          )}
        </ScrollView>
      </View>
    </Screen>
  );
}

export default function EarningsScreen() {
  return <NativeEarningsScreen />;
}

// Reference: midnightEmber kept imported for potential subcomponent override
// (not used directly here — subcomponents handle their own tokens).
void midnightEmber;
