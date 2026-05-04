/**
 * PerformanceMetricsSection — extracted from
 * apps/driver/app/(tabs)/earnings.tsx for PR-A.
 *
 * Renders the "Rendimiento" header + 6 driver metric cards in 3 rows × 2:
 *   - Row 1: Tasa aceptación | Tasa completado
 *   - Row 2: Tasa cancelación (pressable → /profile/penalties) | Tiempo respuesta
 *   - Row 3: Esta semana | Match score
 *
 * Renders nothing when `stats` is null (the fetch failed silently or
 * is still pending — same gating as the original inline version).
 *
 * Visual + tokens preserved verbatim from the inline version.
 * Migration to midnightEmber happens in PR-B.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
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

  return (
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
          accessibilityLabel={`${t('earnings.acceptance_rate', { defaultValue: 'Tasa aceptación' })}: ${Math.round(stats.acceptanceRate * 100)}%`}
        >
          <Text variant="badge" style={{ color: lt.text.secondary }}>
            {t('earnings.acceptance_rate', { defaultValue: 'Tasa aceptación' })}
          </Text>
          <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
            {Math.round(stats.acceptanceRate * 100)}%
          </Text>
        </Card>
        <Card
          variant="filled"
          padding="md"
          className="flex-1"
          style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
          accessible={true}
          accessibilityLabel={`${t('earnings.completion_rate', { defaultValue: 'Tasa completado' })}: ${Math.round(stats.completionRate * 100)}%`}
        >
          <Text variant="badge" style={{ color: lt.text.secondary }}>
            {t('earnings.completion_rate', { defaultValue: 'Tasa completado' })}
          </Text>
          <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
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
            style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
            accessible={true}
            accessibilityLabel={`${t('earnings.cancellation_rate', { defaultValue: 'Tasa cancelación' })}: ${Math.round(stats.cancellationRate * 100)}%`}
          >
            <Text variant="badge" style={{ color: lt.text.secondary }}>
              {t('earnings.cancellation_rate', { defaultValue: 'Tasa cancelación' })}
            </Text>
            <Text variant="metric" style={{ color: stats.cancellationRate > 0.15 ? '#EF4444' : lt.text.primary }} className="mt-1">
              {Math.round(stats.cancellationRate * 100)}%
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
          accessibilityLabel={`${t('earnings.avg_response_time', { defaultValue: 'Tiempo respuesta' })}: ${stats.avgResponseTimeS != null ? `${stats.avgResponseTimeS}s` : '—'}`}
        >
          <Text variant="badge" style={{ color: lt.text.secondary }}>
            {t('earnings.avg_response_time', { defaultValue: 'Tiempo respuesta' })}
          </Text>
          <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
            {stats.avgResponseTimeS != null ? `${stats.avgResponseTimeS}s` : '—'}
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
          accessibilityLabel={`${t('earnings.rides_this_week', { defaultValue: 'Esta semana' })}: ${stats.ridesThisWeek}`}
        >
          <Text variant="badge" style={{ color: lt.text.secondary }}>
            {t('earnings.rides_this_week', { defaultValue: 'Esta semana' })}
          </Text>
          <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
            {stats.ridesThisWeek}
          </Text>
        </Card>
        <Card
          variant="filled"
          padding="md"
          className="flex-1"
          style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
          accessible={true}
          accessibilityLabel={`${t('earnings.match_score', { defaultValue: 'Puntuación' })}: ${stats.matchScore}`}
        >
          <Text variant="badge" style={{ color: lt.text.secondary }}>
            {t('earnings.match_score', { defaultValue: 'Puntuación' })}
          </Text>
          <Text variant="metric" style={{ color: lt.text.primary }} className="mt-1">
            {stats.matchScore}
          </Text>
        </Card>
      </View>
    </View>
  );
}
