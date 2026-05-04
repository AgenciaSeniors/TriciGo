/**
 * EarningsStatsCards — extracted from apps/driver/app/(tabs)/earnings.tsx
 * for PR-A.
 *
 * Renders the 6 stat cards in 3 rows × 2 columns:
 *   - Row 1: Ganancia neta (with optional trend arrow + commission chip)
 *            | Total trips
 *   - Row 2: Promedio por viaje | Rating ★ (pressable → /profile/reviews)
 *   - Row 3: Viajes/h | Ganancia/h
 *
 * Trend arrow is shown only when `trendPct` is computed (previous-period
 * data was successfully fetched). Commission chip only when there are
 * trips with commission > 0.
 *
 * Behaviour preserved verbatim. Tokens migrated in PR-B; the 6-cards
 * layout is replaced with a single hero + collapsible section in PR-C.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP } from '@tricigo/utils';
import { colors, driverStandardLightColors } from '@tricigo/theme';

const lt = driverStandardLightColors;
const CARD_BG = lt.card;
const BORDER_SUBTLE = lt.border.default;
const CARD_SHADOW = {
  shadowColor: '#000',
  shadowOpacity: 0.04,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 2 },
  elevation: 2,
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
            {formatCUP(stats.netEarnings)}
          </Text>
          {stats.totalCommission > 0 && (
            <Text variant="badge" style={{ color: '#EF4444' }} className="mt-0.5">
              {t('earnings.commission_label', { defaultValue: 'Comision' })}: {formatCUP(stats.totalCommission)}
            </Text>
          )}
          {trendPct !== null && (
            /* UX: arrow icon + color is a clearer at-a-glance trend
               signal than plain text. Drivers scan dashboards fast —
               the ↑/↓ gets parsed pre-verbally. */
            <View className="flex-row items-center mt-0.5 gap-1">
              <Ionicons
                name={trendPct >= 0 ? 'trending-up' : 'trending-down'}
                size={13}
                color={trendPct >= 0 ? colors.success.DEFAULT : '#EF4444'}
              />
              <Text
                variant="badge"
                style={{ color: trendPct >= 0 ? colors.success.DEFAULT : '#EF4444' }}
              >
                {trendPct >= 0
                  ? t('earnings.trend_up', { pct: trendPct, defaultValue: `+${trendPct}% vs anterior` })
                  : t('earnings.trend_down', { pct: Math.abs(trendPct), defaultValue: `${trendPct}% vs anterior` })}
              </Text>
            </View>
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
            {stats.completedCount}
          </Text>
        </Card>
      </View>

      {/* Avg per trip + Rating */}
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
            {formatCUP(stats.avgPerTrip)}
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

      {/* Time-adjusted productivity: rides/hr + $/hr */}
      <View className="flex-row gap-3 mb-4">
        <Card
          variant="filled"
          padding="md"
          className="flex-1"
          style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
        >
          <Text variant="badge" style={{ color: lt.text.secondary }}>
            {t('earnings.rides_per_hour', { defaultValue: 'Viajes por hora' })}
          </Text>
          <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
            {stats.totalHours > 0 ? stats.ridesPerHour.toFixed(1) : '—'}
          </Text>
        </Card>
        <Card
          variant="filled"
          padding="md"
          className="flex-1"
          style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
        >
          <Text variant="badge" style={{ color: lt.text.secondary }}>
            {t('earnings.earnings_per_hour', { defaultValue: 'Ganancia por hora' })}
          </Text>
          <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
            {stats.totalHours > 0 ? formatCUP(stats.earningsPerHour) : '—'}
          </Text>
        </Card>
      </View>
    </>
  );
}
