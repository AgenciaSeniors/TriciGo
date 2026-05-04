/**
 * EarningsStatsCards — Midnight Ember edition (PR-B).
 *
 * 6 stat cards in 3 rows × 2 columns. Trend arrow up/down + commission
 * chip migrate from raw hex to semantic state tokens.
 *
 * v2 tokenization:
 *   - Card surface: shared `surfaceStyle` (screen.bg.surface +
 *     line.default + radius.card + shadow.card).
 *   - Trend arrow: `state.success` (positive) / `state.danger`
 *     (negative). Same color drives the icon and the badge text.
 *   - Commission chip: `state.danger` (was hex `#EF4444`).
 *   - Rating "→" affordance: `accent[500]`.
 *   - All `lt.text.*` references replaced with
 *     `midnightEmber.screen.text.*`.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP } from '@tricigo/utils';
import { midnightEmber } from '@tricigo/theme';

const surfaceStyle = {
  backgroundColor: midnightEmber.screen.bg.surface,
  borderWidth: 1,
  borderColor: midnightEmber.screen.line.default,
  borderRadius: midnightEmber.radius.card,
  ...midnightEmber.shadow.card,
};

export interface PeriodStats {
  totalEarnings: number;
  totalCommission: number;
  netEarnings: number;
  completedCount: number;
  avgPerTrip: number;
  totalHours: number;
  ridesPerHour: number;
  earningsPerHour: number;
}

interface EarningsStatsCardsProps {
  stats: PeriodStats;
  trendPct: number | null;
  avgRating: number | null;
  totalReviews: number;
}

export function EarningsStatsCards({
  stats,
  trendPct,
  avgRating,
  totalReviews,
}: EarningsStatsCardsProps) {
  const { t } = useTranslation('driver');

  return (
    <>
      {/* Net earnings + total trips */}
      <View className="flex-row gap-3 mb-2">
        <Card variant="filled" padding="md" className="flex-1" style={surfaceStyle}>
          <Text
            variant="badge"
            style={{ color: midnightEmber.screen.text.secondary }}
          >
            {t('earnings.net_today', { defaultValue: 'Ganancia neta' })}
          </Text>
          <Text
            variant="metric"
            style={{ color: midnightEmber.screen.text.primary, marginTop: 4 }}
          >
            {formatCUP(stats.netEarnings)}
          </Text>
          {stats.totalCommission > 0 && (
            <Text
              variant="badge"
              style={{ color: midnightEmber.state.danger, marginTop: 2 }}
            >
              {t('earnings.commission_label', { defaultValue: 'Comision' })}: {formatCUP(stats.totalCommission)}
            </Text>
          )}
          {trendPct !== null && (
            /* UX: arrow icon + color is a clearer at-a-glance trend signal
               than plain text. Drivers scan dashboards fast — the ↑/↓
               gets parsed pre-verbally. */
            <View className="flex-row items-center mt-0.5 gap-1">
              <Ionicons
                name={trendPct >= 0 ? 'trending-up' : 'trending-down'}
                size={13}
                color={trendPct >= 0 ? midnightEmber.state.success : midnightEmber.state.danger}
              />
              <Text
                variant="badge"
                style={{
                  color: trendPct >= 0
                    ? midnightEmber.state.success
                    : midnightEmber.state.danger,
                }}
              >
                {trendPct >= 0
                  ? t('earnings.trend_up', { pct: trendPct, defaultValue: `+${trendPct}% vs anterior` })
                  : t('earnings.trend_down', { pct: Math.abs(trendPct), defaultValue: `${trendPct}% vs anterior` })}
              </Text>
            </View>
          )}
        </Card>
        <Card variant="filled" padding="md" className="flex-1" style={surfaceStyle}>
          <Text
            variant="badge"
            style={{ color: midnightEmber.screen.text.secondary }}
          >
            {t('earnings.total_trips')}
          </Text>
          <Text
            variant="metric"
            style={{ color: midnightEmber.screen.text.primary, marginTop: 4 }}
          >
            {stats.completedCount}
          </Text>
        </Card>
      </View>

      {/* Avg per trip + Rating */}
      <View className="flex-row gap-3 mb-4">
        <Card variant="filled" padding="md" className="flex-1" style={surfaceStyle}>
          <Text
            variant="badge"
            style={{ color: midnightEmber.screen.text.secondary }}
          >
            {t('earnings.avg_per_trip', { defaultValue: 'Promedio por viaje' })}
          </Text>
          <Text
            variant="metric"
            style={{ color: midnightEmber.screen.text.primary, marginTop: 4 }}
          >
            {formatCUP(stats.avgPerTrip)}
          </Text>
        </Card>
        <Pressable
          onPress={() => router.push('/profile/reviews')}
          accessibilityRole="button"
          accessibilityLabel={t('earnings.see_reviews', { defaultValue: 'Ver reseñas' })}
        >
          <Card variant="filled" padding="md" className="flex-1" style={surfaceStyle}>
            <Text
              variant="badge"
              style={{ color: midnightEmber.screen.text.secondary }}
            >
              {t('earnings.rating')}
            </Text>
            <View className="flex-row items-center mt-1">
              <Text
                variant="metric"
                style={{ color: midnightEmber.screen.text.primary, marginRight: 4 }}
              >
                {avgRating != null ? `★ ${avgRating.toFixed(1)}` : '★ —'}
              </Text>
              {totalReviews > 0 && (
                <Text
                  variant="badge"
                  style={{ color: midnightEmber.screen.text.secondary }}
                >
                  ({totalReviews})
                </Text>
              )}
            </View>
            <Text
              variant="badge"
              style={{ color: midnightEmber.accent[500], marginTop: 4 }}
            >
              {t('earnings.see_reviews', { defaultValue: 'Ver reseñas →' })}
            </Text>
          </Card>
        </Pressable>
      </View>

      {/* Time-adjusted productivity: rides/hr + $/hr */}
      <View className="flex-row gap-3 mb-4">
        <Card variant="filled" padding="md" className="flex-1" style={surfaceStyle}>
          <Text
            variant="badge"
            style={{ color: midnightEmber.screen.text.secondary }}
          >
            {t('earnings.rides_per_hour', { defaultValue: 'Viajes por hora' })}
          </Text>
          <Text
            variant="metric"
            style={{ color: midnightEmber.screen.text.primary, marginTop: 4 }}
          >
            {stats.totalHours > 0 ? stats.ridesPerHour.toFixed(1) : '—'}
          </Text>
        </Card>
        <Card variant="filled" padding="md" className="flex-1" style={surfaceStyle}>
          <Text
            variant="badge"
            style={{ color: midnightEmber.screen.text.secondary }}
          >
            {t('earnings.earnings_per_hour', { defaultValue: 'Ganancia por hora' })}
          </Text>
          <Text
            variant="metric"
            style={{ color: midnightEmber.screen.text.primary, marginTop: 4 }}
          >
            {stats.totalHours > 0 ? formatCUP(stats.earningsPerHour) : '—'}
          </Text>
        </Card>
      </View>
    </>
  );
}
