/**
 * PerformanceMetricsSection — Midnight Ember edition (PR-B) +
 * cancellation-rate soft alert (Phase 2 N3).
 *
 * "Rendimiento" header + 6 driver metric cards (acceptance, completion,
 * cancellation→penalties, response time, rides_this_week, match_score).
 * When the driver's cancellation_rate goes above the 15% policy
 * threshold, a soft amber banner appears above the cards prompting
 * them to review what's happening — this is the user-visible piece
 * of N3. The deeper trigger-based snapshot column is deferred to a
 * future PR with proper DB migration review.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
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
        {t('earnings.performance_title', { defaultValue: 'Cómo vas' })}
      </Text>

      {/* N3 soft alert — cancellation rate over the 15% policy threshold.
          Tapping opens the penalties screen so the driver can see which
          specific rides drove the rate up. */}
      {cancellationOverPolicy && (
        <Pressable
          onPress={() => router.push('/profile/penalties')}
          accessibilityRole="button"
          accessibilityLabel={t('earnings.cancellation_alert_label', {
            defaultValue: 'Tu tasa de cancelación está alta — toca para ver detalles',
          })}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            padding: 12,
            marginBottom: 12,
            borderRadius: midnightEmber.radius.card,
            backgroundColor: `${midnightEmber.state.warning}1F`, // ~12% tint
            borderWidth: 1,
            borderColor: `${midnightEmber.state.warning}66`, // ~40%
          }}
        >
          <Ionicons
            name="alert-circle"
            size={20}
            color={midnightEmber.state.warning}
          />
          <View style={{ flex: 1 }}>
            <Text
              variant="bodySmall"
              style={{
                color: midnightEmber.state.warning,
                fontWeight: '600',
              }}
            >
              {t('earnings.cancellation_alert_title', {
                pct: Math.round(stats.cancellationRate * 100),
                defaultValue: `Cancelaste el ${Math.round(stats.cancellationRate * 100)}% de los viajes`,
              })}
            </Text>
            <Text
              variant="caption"
              style={{ color: midnightEmber.screen.text.secondary, marginTop: 2 }}
            >
              {t('earnings.cancellation_alert_desc', {
                defaultValue: 'Está sobre el 15% que pide la plataforma. Toca para ver qué pasó.',
              })}
            </Text>
          </View>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={midnightEmber.screen.text.tertiary}
          />
        </Pressable>
      )}

      <View className="flex-row gap-3 mb-3">
        <Card
          variant="filled"
          padding="md"
          className="flex-1"
          style={surfaceStyle}
          accessible
          accessibilityLabel={`${t('earnings.acceptance_rate', { defaultValue: 'Aceptas' })}: ${Math.round(stats.acceptanceRate * 100)}%`}
        >
          <Text variant="badge" style={{ color: midnightEmber.screen.text.secondary }}>
            {t('earnings.acceptance_rate', { defaultValue: 'Aceptas' })}
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
          accessibilityLabel={`${t('earnings.completion_rate', { defaultValue: 'Completas' })}: ${Math.round(stats.completionRate * 100)}%`}
        >
          <Text variant="badge" style={{ color: midnightEmber.screen.text.secondary }}>
            {t('earnings.completion_rate', { defaultValue: 'Completas' })}
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
            accessibilityLabel={`${t('earnings.cancellation_rate', { defaultValue: 'Cancelas' })}: ${Math.round(stats.cancellationRate * 100)}%`}
          >
            <Text variant="badge" style={{ color: midnightEmber.screen.text.secondary }}>
              {t('earnings.cancellation_rate', { defaultValue: 'Cancelas' })}
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
          accessibilityLabel={`${t('earnings.avg_response_time', { defaultValue: 'Respondes en' })}: ${stats.avgResponseTimeS != null ? `${stats.avgResponseTimeS}s` : '—'}`}
        >
          <Text variant="badge" style={{ color: midnightEmber.screen.text.secondary }}>
            {t('earnings.avg_response_time', { defaultValue: 'Respondes en' })}
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
