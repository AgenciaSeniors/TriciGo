/**
 * PerformanceMetricsSection — Midnight Ember edition (PR-B).
 *
 * "Rendimiento" header + 6 driver metric cards (acceptance, completion,
 * cancellation→penalties, response time, rides_this_week, match_score).
 *
 * v2 tokenization:
 *   - Card surface: shared `surfaceStyle` (screen.bg.surface +
 *     line.default + radius.card + shadow.card).
 *   - Cancellation rate metric switches to `state.danger` when above
 *     the 15% policy threshold (was raw `#EF4444`).
 *   - "Ver penalidades →" link uses `accent[500]`.
 *   - Header + label colors via `midnightEmber.screen.text.*`.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';

const surfaceStyle = {
  backgroundColor: midnightEmber.screen.bg.surface,
  borderWidth: 1,
  borderColor: midnightEmber.screen.line.default,
  borderRadius: midnightEmber.radius.card,
  ...midnightEmber.shadow.card,
};

export interface DriverStats {
  acceptanceRate: number;
  cancellationRate: number;
  completionRate: number;
  ridesThisWeek: number;
  ridesThisMonth: number;
  avgResponseTimeS: number | null;
  matchScore: number;
}

interface PerformanceMetricsSectionProps {
  stats: DriverStats | null;
}

export function PerformanceMetricsSection({ stats }: PerformanceMetricsSectionProps) {
  const { t } = useTranslation('driver');

  if (!stats) return null;

  const cancellationOverPolicy = stats.cancellationRate > 0.15;

  return (
    <View className="mt-8">
      <Text
        variant="h4"
        style={{ color: midnightEmber.screen.text.primary, marginBottom: 12 }}
      >
        {t('earnings.performance_title', { defaultValue: 'Rendimiento' })}
      </Text>
      <View className="flex-row gap-3 mb-3">
        <Card
          variant="filled"
          padding="md"
          className="flex-1"
          style={surfaceStyle}
          accessible
          accessibilityLabel={`${t('earnings.acceptance_rate', { defaultValue: 'Tasa aceptación' })}: ${Math.round(stats.acceptanceRate * 100)}%`}
        >
          <Text variant="badge" style={{ color: midnightEmber.screen.text.secondary }}>
            {t('earnings.acceptance_rate', { defaultValue: 'Tasa aceptación' })}
          </Text>
          <Text
            variant="metric"
            style={{ color: midnightEmber.screen.text.primary, marginTop: 4 }}
          >
            {Math.round(stats.acceptanceRate * 100)}%
          </Text>
        </Card>
        <Card
          variant="filled"
          padding="md"
          className="flex-1"
          style={surfaceStyle}
          accessible
          accessibilityLabel={`${t('earnings.completion_rate', { defaultValue: 'Tasa completado' })}: ${Math.round(stats.completionRate * 100)}%`}
        >
          <Text variant="badge" style={{ color: midnightEmber.screen.text.secondary }}>
            {t('earnings.completion_rate', { defaultValue: 'Tasa completado' })}
          </Text>
          <Text
            variant="metric"
            style={{ color: midnightEmber.screen.text.primary, marginTop: 4 }}
          >
            {Math.round(stats.completionRate * 100)}%
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
            style={surfaceStyle}
            accessible
            accessibilityLabel={`${t('earnings.cancellation_rate', { defaultValue: 'Tasa cancelación' })}: ${Math.round(stats.cancellationRate * 100)}%`}
          >
            <Text variant="badge" style={{ color: midnightEmber.screen.text.secondary }}>
              {t('earnings.cancellation_rate', { defaultValue: 'Tasa cancelación' })}
            </Text>
            <Text
              variant="metric"
              style={{
                marginTop: 4,
                color: cancellationOverPolicy
                  ? midnightEmber.state.danger
                  : midnightEmber.screen.text.primary,
              }}
            >
              {Math.round(stats.cancellationRate * 100)}%
            </Text>
            <Text variant="badge" style={{ color: midnightEmber.accent[500], marginTop: 4 }}>
              {t('earnings.see_penalties', { defaultValue: 'Ver penalidades →' })}
            </Text>
          </Card>
        </Pressable>
        <Card
          variant="filled"
          padding="md"
          className="flex-1"
          style={surfaceStyle}
          accessible
          accessibilityLabel={`${t('earnings.avg_response_time', { defaultValue: 'Tiempo respuesta' })}: ${stats.avgResponseTimeS != null ? `${stats.avgResponseTimeS}s` : '—'}`}
        >
          <Text variant="badge" style={{ color: midnightEmber.screen.text.secondary }}>
            {t('earnings.avg_response_time', { defaultValue: 'Tiempo respuesta' })}
          </Text>
          <Text
            variant="metric"
            style={{ color: midnightEmber.screen.text.primary, marginTop: 4 }}
          >
            {stats.avgResponseTimeS != null ? `${stats.avgResponseTimeS}s` : '—'}
          </Text>
        </Card>
      </View>
      <View className="flex-row gap-3">
        <Card
          variant="filled"
          padding="md"
          className="flex-1"
          style={surfaceStyle}
          accessible
          accessibilityLabel={`${t('earnings.rides_this_week', { defaultValue: 'Esta semana' })}: ${stats.ridesThisWeek}`}
        >
          <Text variant="badge" style={{ color: midnightEmber.screen.text.secondary }}>
            {t('earnings.rides_this_week', { defaultValue: 'Esta semana' })}
          </Text>
          <Text
            variant="metric"
            style={{ color: midnightEmber.screen.text.primary, marginTop: 4 }}
          >
            {stats.ridesThisWeek}
          </Text>
        </Card>
        <Card
          variant="filled"
          padding="md"
          className="flex-1"
          style={surfaceStyle}
          accessible
          accessibilityLabel={`${t('earnings.match_score', { defaultValue: 'Puntuación' })}: ${stats.matchScore}`}
        >
          <Text variant="badge" style={{ color: midnightEmber.screen.text.secondary }}>
            {t('earnings.match_score', { defaultValue: 'Puntuación' })}
          </Text>
          <Text
            variant="metric"
            style={{ color: midnightEmber.screen.text.primary, marginTop: 4 }}
          >
            {stats.matchScore}
          </Text>
        </Card>
      </View>
    </View>
  );
}
