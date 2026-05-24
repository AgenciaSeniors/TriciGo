/**
 * Earnings dashboard — orchestrator (PR-A extraction landed).
 *
 * The previous monolith (1118 LOC, including a 209-LOC inline
 * EarningsGoalCard component, a 38-LOC zombie EarningsChart that was
 * no longer used, an 85-LOC fetchData callback in line, and a
 * 522-LOC return JSX with 9 stacked sections) was split into focused
 * subcomponents under `apps/driver/src/components/earnings/` plus a
 * single data-fetching hook under `apps/driver/src/hooks/`.
 *
 *   Subcomponents (see `apps/driver/src/components/earnings/*`):
 *     - EarningsHeader            — title + balance + Wallet CTA
 *     - PeriodTabs                — Hoy / Semana / Mes pill row
 *     - EarningsGoalCard          — daily goal + milestone toasts
 *     - EarningsStatsCards        — 6 stat cards (3 × 2)
 *     - PerformanceMetricsSection — driver KPIs (acceptance, etc.)
 *     - QuestsSection             — quest progress list
 *     - RecentActivitySection     — collapsible txn list
 *
 *   Hook:
 *     - useEarningsData — every fetch (critical / deferred / trend /
 *                          tx pagination) + the `Period` type and
 *                          `getDateRange` helper used by zone chart.
 *
 * Removed in this PR:
 *
 *   - `EarningsChart` legacy bar chart (lines 92-129 of the old file).
 *     It was never imported in the JSX after `<EarningsBarChart>`
 *     replaced it long ago — pure dead code.
 *
 * PR-A is a pure refactor: zero visual changes, zero behaviour
 * changes. Migration to `midnightEmber` tokens lands in PR-B;
 * storytelling hero + microcopy unification in PR-C.
 */
import React, { useMemo, useState } from 'react';
import { View, ScrollView, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { SkeletonBalance, SkeletonCard } from '@tricigo/ui/Skeleton';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';
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
import { tripNetEarnings } from '@/utils/tripNetEarnings';
import { EarningsHeader } from '@/components/earnings/EarningsHeader';
import { PeriodTabs } from '@/components/earnings/PeriodTabs';
import { EarningsGoalCard } from '@/components/earnings/EarningsGoalCard';
import { EarningsStatsCards } from '@/components/earnings/EarningsStatsCards';
import { PerformanceMetricsSection } from '@/components/earnings/PerformanceMetricsSection';
import { QuestsSection } from '@/components/earnings/QuestsSection';
import { RecentActivitySection } from '@/components/earnings/RecentActivitySection';

/**
 * Aggregate completed trips by their day-of-week label so the
 * `EarningsBarChart` can render one bar per day. Kept here because the
 * orchestrator is the only consumer.
 *
 * BUG-fare-audit B5: each bar now reports NET earnings (fare − commission
 * + tip) via `tripNetEarnings`, matching the today/prev totals from
 * useEarningsData and the receipt PDF — previously each bar showed gross
 * `final_fare_cup`, which made the chart sum higher than the headline
 * "Hoy" stat just above it.
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

  const [period, setPeriod] = useState<Period>('day');
  const [txExpanded, setTxExpanded] = useState(false);

  // N2 — personal peak hours (DOW × hour earnings heatmap, last 30d)
  const { data: peakHours, loading: peakHoursLoading } = useDriverPeakHours({
    driverId: driverProfileId,
    days: 30,
    enabled: !!driverProfileId,
  });

  const {
    loading,
    refreshing,
    // Sub-PR E: `balance` no se desestructura más porque EarningsHeader ya
    // no muestra BalanceBadge (consolidado al tab Wallet). El hook sigue
    // exponiendo el field para callers futuros pero acá ya no se usa.
    periodTrips,
    commissionRate,
    avgRating,
    totalReviews,
    todayEarnings,
    prevPeriodEarnings,
    quests,
    driverStats,
    transactions,
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

  // Per-period stats derived from the trips list.
  const periodStats = useMemo(() => {
    let totalEarnings = 0;
    let totalCommission = 0;
    let completedCount = 0;
    let totalDurationSec = 0;

    for (const trip of periodTrips) {
      const fare = trip.final_fare_cup ?? trip.estimated_fare_cup;
      totalEarnings += fare;
      // Prefer the server-recorded commission (final snapshot) so
      // rate changes don't retroactively alter historical earnings.
      // Fall back to the live rate only when no snapshot is attached
      // (legacy rides completed before the snapshot pipeline landed).
      const serverCommission = (trip as Ride & { commission_amount?: number | null }).commission_amount;
      totalCommission += serverCommission != null
        ? serverCommission
        : Math.round(fare * commissionRate);
      completedCount++;
      totalDurationSec += trip.actual_duration_s ?? trip.estimated_duration_s ?? 0;
    }

    const avgPerTrip = completedCount > 0 ? Math.round(totalEarnings / completedCount) : 0;
    const netEarnings = totalEarnings - totalCommission;

    // Time-adjusted metrics — 0 when duration is missing to avoid Infinity.
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

  // Earnings by zone (top 5) — RPC get_driver_earnings_by_zone (migration 00128)
  const periodRange = useMemo(() => getDateRange(period), [period]);
  const { data: earningsByZone, loading: earningsByZoneLoading } = useDriverEarningsByZone({
    driverId: driverProfileId ?? null,
    start: periodRange.start,
    end: periodRange.end,
    enabled: !!driverProfileId,
  });

  // Convert dailyData to BarChartDataPoint[]
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

  // Trend percentage
  const trendPct = useMemo(() => {
    if (prevPeriodEarnings == null || prevPeriodEarnings === 0) return null;
    return Math.round(((periodStats.totalEarnings - prevPeriodEarnings) / prevPeriodEarnings) * 100);
  }, [periodStats.totalEarnings, prevPeriodEarnings]);

  // Check if there is no earnings data at all
  const hasNoEarningsData =
    !loading && periodStats.totalEarnings === 0 && periodStats.completedCount === 0;

  return (
    <Screen bg="lightPrimary" statusBarStyle="dark-content">
      <ScrollView
        className="flex-1 px-5"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refetch}
            tintColor={midnightEmber.accent[500]}
            accessibilityLabel={t('earnings.refresh', { defaultValue: 'Actualizar ganancias' })}
          />
        }
      >
        <View className="pt-4 pb-8">
          {/* Sub-PR E: EarningsHeader simplified — no balance prop, no Ver Wallet button. */}
          <EarningsHeader />

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

          {/* Period Tabs */}
          <PeriodTabs period={period} onChange={setPeriod} />

          {/* Empty state when no earnings data */}
          {hasNoEarningsData ? (
            // UX: weak "0s everywhere" is discouraging for a new driver, and
            // period-agnostic copy ("no tienes ganancias") felt wrong for a
            // driver checking the "Mes" tab on day 2. Period-specific copy +
            // a direct "Ir a Inicio" CTA makes the zero feel actionable rather
            // than terminal.
            <EmptyState
              icon="wallet-outline"
              title={
                period === 'day'
                  ? t('earnings.no_earnings_today_title', { defaultValue: 'Aún sin ganancias hoy' })
                  : period === 'week'
                    ? t('earnings.no_earnings_week_title', { defaultValue: 'Aún sin ganancias esta semana' })
                    : t('earnings.no_earnings_month_title', { defaultValue: 'Aún sin ganancias este mes' })
              }
              description={t('earnings.no_earnings_cta_description', { defaultValue: 'Conectate para empezar a recibir ofertas. Tus ganancias aparecen acá al completar el primer viaje.' })}
              action={{
                label: t('earnings.go_online_cta', { defaultValue: 'Ir a Inicio' }),
                onPress: () => router.push('/(tabs)'),
              }}
            />
          ) : (
          <>
          {/* Bar Chart (SVG) — only on week/month tabs */}
          {period !== 'day' && chartData.length > 0 && (
            <EarningsBarChart data={chartData} theme="light" />
          )}

          {/* PR-C: hero earnings + collapsible "Más métricas" */}
          <EarningsStatsCards
            stats={periodStats}
            trendPct={trendPct}
            avgRating={avgRating}
            totalReviews={totalReviews}
            period={period}
          />

          {/* Hourly Heatmap — current-period trip activity */}
          {periodTrips.length > 0 && (
            <HourlyHeatmap trips={periodTrips} theme="light" />
          )}

          {/* N2 — personal peak hours (30-day earnings × DOW × hour) */}
          <PersonalPeakHours data={peakHours} loading={peakHoursLoading} />

          {/* Earnings by zone (top 5) */}
          <EarningsByZoneChart data={earningsByZone} loading={earningsByZoneLoading} />

          {/* Quests / Missions */}
          <QuestsSection quests={quests} />

          {/* Performance Metrics — null-gated inside the component */}
          <PerformanceMetricsSection stats={driverStats} />

          {/* Recent Wallet Activity (collapsible) */}
          <RecentActivitySection
            transactions={transactions}
            loading={txLoading}
            hasMore={txHasMore}
            onLoadMore={loadMoreTransactions}
            onExpandedChange={setTxExpanded}
          />
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
