/**
 * EarningsStatsCards — PR-C storytelling layout.
 *
 * Replaces the previous 3 × 2 grid of equal-weight stat cards with a
 * single hero amount + a collapsible "Más métricas" drawer. The hero
 * matches the IncomingRideCard's "Ganas" hero family so the driver
 * sees a consistent earnings voice across the app.
 *
 * Layout:
 *   - Hero card: caption (`TE LLEVAS`) + heroLg amount + meta line
 *     (trend arrow · {n} viajes · {x}/h promedio).
 *   - Rating card (always visible) — has its own navigate-to-reviews
 *     affordance so it stays prominent.
 *   - "Más métricas" collapsible toggle. Expanded view shows:
 *     promedio, viajes/h, por hora, comisión.
 *
 * Trend arrow microcopy is now period-specific: `vs ayer` / `vs semana
 * pasada` / `vs mes pasado` instead of a generic "vs período anterior".
 *
 * v2 tokens preserved from PR-B.
 */
import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP } from '@tricigo/utils';
import { midnightEmber } from '@tricigo/theme';
import type { Period } from './PeriodTabs';

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
  /** Drives the period-specific trend microcopy (`vs ayer/semana/mes`). */
  period: Period;
}

export function EarningsStatsCards({
  stats,
  trendPct,
  avgRating,
  totalReviews,
  period,
}: EarningsStatsCardsProps) {
  const { t } = useTranslation('driver');
  const [moreOpen, setMoreOpen] = useState(false);

  // PR-C: trend microcopy is now period-specific. The base `trend_up`
  // / `trend_down` keys default to "vs ayer" because the day tab is the
  // default; week/month pivot to dedicated keys.
  const trendKey = (() => {
    if (trendPct == null) return null;
    const dir = trendPct >= 0 ? 'trend_up' : 'trend_down';
    if (period === 'week') return `${dir}_week` as const;
    if (period === 'month') return `${dir}_month` as const;
    return dir;
  })();

  const trendDefault = (() => {
    if (trendPct == null) return '';
    const sign = trendPct >= 0 ? '+' : '';
    if (period === 'week') return `${sign}${trendPct}% vs semana pasada`;
    if (period === 'month') return `${sign}${trendPct}% vs mes pasado`;
    return `${sign}${trendPct}% vs ayer`;
  })();

  return (
    <>
      {/* ── HERO: net earnings + storytelling meta line ── */}
      <Card variant="filled" padding="md" style={surfaceStyle} className="mb-3">
        <Text
          variant="badge"
          style={{
            color: midnightEmber.screen.text.secondary,
            letterSpacing: 1.2,
            textTransform: 'uppercase',
          }}
        >
          {t('earnings.net_today', { defaultValue: 'Te llevas' })}
        </Text>
        <Text
          style={{
            ...midnightEmber.text.heroLg,
            color: midnightEmber.screen.text.primary,
            marginTop: 4,
            marginBottom: 8,
          }}
        >
          {formatCUP(stats.netEarnings)}
        </Text>

        {/* Meta line: trend · trips · per-hour */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 6,
          }}
        >
          {trendPct !== null && trendKey && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons
                name={trendPct >= 0 ? 'trending-up' : 'trending-down'}
                size={13}
                color={
                  trendPct >= 0
                    ? midnightEmber.state.success
                    : midnightEmber.state.danger
                }
              />
              <Text
                variant="badge"
                style={{
                  color:
                    trendPct >= 0
                      ? midnightEmber.state.success
                      : midnightEmber.state.danger,
                  fontWeight: '600',
                }}
              >
                {t(`earnings.${trendKey}`, {
                  pct: Math.abs(trendPct),
                  defaultValue: trendDefault,
                })}
              </Text>
            </View>
          )}

          {trendPct !== null && (
            <Text
              variant="badge"
              style={{ color: midnightEmber.screen.text.tertiary }}
            >
              ·
            </Text>
          )}

          <Text
            variant="badge"
            style={{ color: midnightEmber.screen.text.secondary }}
          >
            {stats.completedCount} {t('earnings.total_trips', { defaultValue: 'viajes' }).toLowerCase()}
          </Text>

          {stats.totalHours > 0 && (
            <>
              <Text
                variant="badge"
                style={{ color: midnightEmber.screen.text.tertiary }}
              >
                ·
              </Text>
              <Text
                variant="badge"
                style={{ color: midnightEmber.screen.text.secondary }}
              >
                {formatCUP(stats.earningsPerHour)}/h
              </Text>
            </>
          )}
        </View>
      </Card>

      {/* ── Rating + Más métricas toggle ── */}
      <View className="flex-row gap-3 mb-4">
        <Pressable
          onPress={() => router.push('/profile/reviews')}
          accessibilityRole="button"
          accessibilityLabel={t('earnings.see_reviews', { defaultValue: 'Ver reseñas' })}
          style={{ flex: 1 }}
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
                style={{
                  color: midnightEmber.screen.text.primary,
                  marginRight: 4,
                }}
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

        <Pressable
          onPress={() => setMoreOpen((p) => !p)}
          accessibilityRole="button"
          accessibilityState={{ expanded: moreOpen }}
          accessibilityLabel={
            moreOpen
              ? t('earnings.hide_metrics', { defaultValue: 'Ocultar métricas' })
              : t('earnings.more_metrics', { defaultValue: 'Más métricas' })
          }
          style={{ flex: 1 }}
        >
          <Card
            variant="filled"
            padding="md"
            className="flex-1"
            style={{
              ...surfaceStyle,
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 96,
            }}
          >
            <Ionicons
              name={moreOpen ? 'chevron-up' : 'add'}
              size={20}
              color={midnightEmber.accent[500]}
            />
            <Text
              variant="badge"
              style={{
                color: midnightEmber.accent[500],
                marginTop: 4,
                fontWeight: '600',
              }}
            >
              {moreOpen
                ? t('earnings.hide_metrics', { defaultValue: 'Ocultar métricas' })
                : t('earnings.more_metrics', { defaultValue: 'Más métricas' })}
            </Text>
          </Card>
        </Pressable>
      </View>

      {/* ── Más métricas (collapsible drawer) ── */}
      {moreOpen && (
        <View className="mb-4">
          <View className="flex-row gap-3 mb-3">
            <Card variant="filled" padding="md" className="flex-1" style={surfaceStyle}>
              <Text
                variant="badge"
                style={{ color: midnightEmber.screen.text.secondary }}
              >
                {t('earnings.avg_per_trip', { defaultValue: 'Promedio' })}
              </Text>
              <Text
                variant="metric"
                style={{ color: midnightEmber.screen.text.primary, marginTop: 4 }}
              >
                {formatCUP(stats.avgPerTrip)}
              </Text>
            </Card>
            <Card variant="filled" padding="md" className="flex-1" style={surfaceStyle}>
              <Text
                variant="badge"
                style={{ color: midnightEmber.screen.text.secondary }}
              >
                {t('earnings.rides_per_hour', { defaultValue: 'Viajes/h' })}
              </Text>
              <Text
                variant="metric"
                style={{ color: midnightEmber.screen.text.primary, marginTop: 4 }}
              >
                {stats.totalHours > 0 ? stats.ridesPerHour.toFixed(1) : '—'}
              </Text>
            </Card>
          </View>
          <View className="flex-row gap-3">
            <Card variant="filled" padding="md" className="flex-1" style={surfaceStyle}>
              <Text
                variant="badge"
                style={{ color: midnightEmber.screen.text.secondary }}
              >
                {t('earnings.earnings_per_hour', { defaultValue: 'Por hora' })}
              </Text>
              <Text
                variant="metric"
                style={{ color: midnightEmber.screen.text.primary, marginTop: 4 }}
              >
                {stats.totalHours > 0 ? formatCUP(stats.earningsPerHour) : '—'}
              </Text>
            </Card>
            <Card variant="filled" padding="md" className="flex-1" style={surfaceStyle}>
              <Text
                variant="badge"
                style={{ color: midnightEmber.screen.text.secondary }}
              >
                {t('earnings.commission_label', { defaultValue: 'Comisión TriciGo' })}
              </Text>
              <Text
                variant="metric"
                style={{ color: midnightEmber.state.danger, marginTop: 4 }}
              >
                −{formatCUP(stats.totalCommission)}
              </Text>
            </Card>
          </View>
        </View>
      )}
    </>
  );
}
