/**
 * Driver performance dashboard — Phase 2 N3 deep slice.
 *
 * Aggregates the existing `driverService.getDriverStats()` snapshot
 * with the new `getPerformanceTrend(driverId, 30)` series (RPC from
 * migration 00260) into one screen:
 *
 *   - Headline cards (acceptance, cancellation, completion, rating,
 *     avg response time, total rides). Mirrors the data already
 *     surfaced on the earnings tab but consolidated.
 *   - Two 30-day sparklines (acceptance %, cancellation %).
 *   - Soft alerts when:
 *       * cancellation_rate > 15% (policy threshold) — "Tu cancelación
 *         subió esta semana — ¿algo cambió?"
 *       * acceptance_rate dropped > 15% relative to previous week
 *
 * Tolerates missing trend data (00260 not applied to prod) — sparklines
 * just hide and the headline cards keep working from the snapshot.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, ScrollView, ActivityIndicator, StyleSheet, Text as RNText, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber, cubanLight, cubanDark } from '@tricigo/theme';
import { driverService } from '@tricigo/api';
import { logger } from '@tricigo/utils';
import { useDriverStore } from '@/stores/driver.store';
import { useDriverPerformanceTrend } from '@/hooks/useDriverPerformanceTrend';

interface DriverStatsSnapshot {
  acceptanceRate: number;
  cancellationRate: number;
  completionRate: number;
  totalRidesOffered: number;
  totalRidesCompleted: number;
  ridesThisWeek: number;
  ridesThisMonth: number;
  avgResponseTimeS: number | null;
  ratingAvg: number;
}

const SPARKLINE_HEIGHT = 48;
const SPARKLINE_BAR_GAP = 2;

/**
 * Tiny inline sparkline. Receives an array of values (0..1 normalized
 * already by the caller) and renders accent-colored bars. Avoids
 * pulling in a chart library for a 7-day-or-30-day series.
 */
function Sparkline({
  values,
  color,
}: {
  values: number[];
  color: string;
}) {
  if (values.length === 0) return null;
  return (
    <View style={[styles.sparklineRow, { height: SPARKLINE_HEIGHT }]}>
      {values.map((v, i) => {
        const clamped = Math.max(0, Math.min(1, v));
        return (
          <View
            key={i}
            style={{
              flex: 1,
              marginRight: i === values.length - 1 ? 0 : SPARKLINE_BAR_GAP,
              height: Math.max(2, clamped * SPARKLINE_HEIGHT),
              backgroundColor: color,
              borderTopLeftRadius: 2,
              borderTopRightRadius: 2,
              alignSelf: 'flex-end',
            }}
          />
        );
      })}
    </View>
  );
}

interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
  warning?: boolean;
}

function MetricCard({ label, value, hint, warning }: MetricCardProps) {
  return (
    <Card variant="surface" padding="md" style={{ flex: 1, minHeight: 92 }}>
      <RNText
        style={{
          fontSize: 11,
          fontWeight: '600',
          color: midnightEmber.screen.text.tertiary,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </RNText>
      <RNText
        style={{
          fontSize: 24,
          fontWeight: '700',
          color: warning ? midnightEmber.state.warning : midnightEmber.screen.text.primary,
          marginTop: 4,
        }}
      >
        {value}
      </RNText>
      {hint && (
        <RNText
          style={{
            fontSize: 11,
            color: midnightEmber.screen.text.tertiary,
            marginTop: 2,
          }}
        >
          {hint}
        </RNText>
      )}
    </Card>
  );
}

export default function PerformanceScreen() {
  const { t } = useTranslation('driver');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  const driverProfile = useDriverStore((s) => s.profile);
  const driverId = driverProfile?.id ?? null;

  const [snapshot, setSnapshot] = useState<DriverStatsSnapshot | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(true);

  const { trend, loading: loadingTrend } = useDriverPerformanceTrend({
    driverId,
    days: 30,
  });

  useEffect(() => {
    if (!driverId) return;
    let cancelled = false;
    driverService
      .getDriverStats(driverId)
      .then((s) => {
        if (!cancelled) setSnapshot(s);
      })
      .catch((err) => {
        logger.warn('[performance] snapshot failed', { error: String(err) });
      })
      .finally(() => {
        if (!cancelled) setLoadingSnapshot(false);
      });
    return () => {
      cancelled = true;
    };
  }, [driverId]);

  const acceptanceSeries = useMemo(() => {
    return trend.map((d) => {
      const total = d.accepted_count + d.canceled_count;
      if (total === 0) return 0;
      return d.accepted_count / total;
    });
  }, [trend]);

  const cancellationSeries = useMemo(() => {
    return trend.map((d) => {
      const total = d.completed_count + d.canceled_count;
      if (total === 0) return 0;
      return d.canceled_count / total;
    });
  }, [trend]);

  // Last-7-day average for the alert comparison
  const last7AcceptanceAvg = useMemo(() => {
    const slice = acceptanceSeries.slice(-7);
    if (slice.length === 0) return null;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }, [acceptanceSeries]);

  const prev7AcceptanceAvg = useMemo(() => {
    const slice = acceptanceSeries.slice(-14, -7);
    if (slice.length === 0) return null;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }, [acceptanceSeries]);

  // Acceptance dropped > 15% week-over-week?
  const acceptanceDropAlert = useMemo(() => {
    if (last7AcceptanceAvg == null || prev7AcceptanceAvg == null) return null;
    if (prev7AcceptanceAvg < 0.05) return null; // base too low to compare
    const delta = last7AcceptanceAvg - prev7AcceptanceAvg;
    if (delta < -0.15) {
      return {
        deltaPct: Math.round(delta * 100),
      };
    }
    return null;
  }, [last7AcceptanceAvg, prev7AcceptanceAvg]);

  if (!driverId) {
    return (
      <Screen bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'}>
        <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
        <ScreenHeader
          title={t('performance.title', { defaultValue: 'Mi desempeño' })}
          onBack={() => router.back()}
        />
        <View style={styles.centered}>
          <Text variant="body" color="secondary">
            {t('performance.no_profile', { defaultValue: 'Sin perfil de conductor' })}
          </Text>
        </View>
        </View>
      </Screen>
    );
  }

  if (loadingSnapshot) {
    return (
      <Screen bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'}>
        <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
        <ScreenHeader
          title={t('performance.title', { defaultValue: 'Mi desempeño' })}
          onBack={() => router.back()}
        />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={midnightEmber.accent[500]} />
        </View>
        </View>
      </Screen>
    );
  }

  if (!snapshot) {
    return (
      <Screen bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'}>
        <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
        <ScreenHeader
          title={t('performance.title', { defaultValue: 'Mi desempeño' })}
          onBack={() => router.back()}
        />
        <View style={styles.centered}>
          <Text variant="body" color="secondary">
            {t('performance.no_data', { defaultValue: 'Sin datos disponibles' })}
          </Text>
        </View>
        </View>
      </Screen>
    );
  }

  const cancellationOverPolicy = snapshot.cancellationRate > 0.15;

  return (
    <Screen bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'}>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
      <ScreenHeader
        title={t('performance.title', { defaultValue: 'Mi desempeño' })}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={styles.body}>
        {/* Alerts (above the cards, at most one shown at a time, danger > warning) */}
        {cancellationOverPolicy && (
          <Card variant="outlined" padding="md" style={styles.alertCard}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
              <Ionicons name="warning-outline" size={18} color={midnightEmber.state.warning} style={{ marginTop: 2 }} />
              <View style={{ flex: 1 }}>
                <RNText style={[styles.alertTitle, { color: midnightEmber.state.warning }]}>
                  {t('performance.alert_cancellation_title', {
                    pct: Math.round(snapshot.cancellationRate * 100),
                    defaultValue: `Cancelaste ${Math.round(snapshot.cancellationRate * 100)}% de tus viajes — sobre el límite del 15%`,
                  })}
                </RNText>
                <RNText style={styles.alertBody}>
                  {t('performance.alert_cancellation_body', {
                    defaultValue: 'Cancelaciones repetidas afectan tu match score y tus ofertas. Si pasó algo puntual, ignorá este aviso.',
                  })}
                </RNText>
              </View>
            </View>
          </Card>
        )}

        {acceptanceDropAlert && !cancellationOverPolicy && (
          <Card variant="outlined" padding="md" style={styles.alertCard}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
              <Ionicons name="trending-down-outline" size={18} color={midnightEmber.state.info} style={{ marginTop: 2 }} />
              <View style={{ flex: 1 }}>
                <RNText style={[styles.alertTitle, { color: midnightEmber.state.info }]}>
                  {t('performance.alert_acceptance_title', {
                    pct: Math.abs(acceptanceDropAlert.deltaPct),
                    defaultValue: `Tu acceptance rate bajó ${Math.abs(acceptanceDropAlert.deltaPct)}% esta semana`,
                  })}
                </RNText>
                <RNText style={styles.alertBody}>
                  {t('performance.alert_acceptance_body', {
                    defaultValue: '¿Algo cambió? Aceptar más viajes mejora tu posición en el matching.',
                  })}
                </RNText>
              </View>
            </View>
          </Card>
        )}

        {/* Headline cards — 2 columns × 3 rows */}
        <View style={styles.cardGrid}>
          <View style={styles.cardRow}>
            <MetricCard
              label={t('performance.acceptance_label', { defaultValue: 'Aceptación' })}
              value={`${Math.round(snapshot.acceptanceRate * 100)}%`}
              hint={t('performance.acceptance_hint', { defaultValue: 'Últimos viajes ofrecidos' })}
            />
            <MetricCard
              label={t('performance.cancellation_label', { defaultValue: 'Cancelaciones' })}
              value={`${Math.round(snapshot.cancellationRate * 100)}%`}
              hint={t('performance.cancellation_hint', { defaultValue: 'Política: <15%' })}
              warning={cancellationOverPolicy}
            />
          </View>
          <View style={styles.cardRow}>
            <MetricCard
              label={t('performance.completion_label', { defaultValue: 'Completitud' })}
              value={`${Math.round(snapshot.completionRate * 100)}%`}
            />
            <MetricCard
              label={t('performance.rating_label', { defaultValue: 'Calificación' })}
              value={snapshot.ratingAvg ? snapshot.ratingAvg.toFixed(2) : '—'}
              hint={t('performance.rating_hint', { defaultValue: 'Promedio últimos viajes' })}
            />
          </View>
          <View style={styles.cardRow}>
            <MetricCard
              label={t('performance.response_label', { defaultValue: 'Respuesta media' })}
              value={
                snapshot.avgResponseTimeS != null
                  ? `${snapshot.avgResponseTimeS}s`
                  : '—'
              }
              hint={t('performance.response_hint', { defaultValue: 'Tiempo a aceptar' })}
            />
            <MetricCard
              label={t('performance.total_rides_label', { defaultValue: 'Viajes totales' })}
              value={`${snapshot.totalRidesCompleted}`}
              hint={t('performance.total_rides_hint', {
                offered: snapshot.totalRidesOffered,
                defaultValue: `${snapshot.totalRidesOffered} ofrecidos`,
              })}
            />
          </View>
        </View>

        {/* Sparklines — only when we have a non-empty trend */}
        {trend.length > 0 && (
          <>
            <Card variant="surface" padding="md" style={{ marginTop: 16 }}>
              <RNText style={styles.trendLabel}>
                {t('performance.trend_acceptance', { defaultValue: 'Aceptación · 30 días' })}
              </RNText>
              <Sparkline values={acceptanceSeries} color={midnightEmber.accent[500]} />
            </Card>
            <Card variant="surface" padding="md" style={{ marginTop: 12 }}>
              <RNText style={styles.trendLabel}>
                {t('performance.trend_cancellation', { defaultValue: 'Cancelación · 30 días' })}
              </RNText>
              <Sparkline values={cancellationSeries} color={midnightEmber.state.warning} />
            </Card>
          </>
        )}

        {trend.length === 0 && !loadingTrend && (
          <Card variant="outlined" padding="md" style={{ marginTop: 16 }}>
            <RNText style={[styles.alertBody, { textAlign: 'center' }]}>
              {t('performance.trend_unavailable', {
                defaultValue: 'Tendencia diaria no disponible aún. Volvé en unos días.',
              })}
            </RNText>
          </Card>
        )}
      </ScrollView>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    padding: 16,
    paddingBottom: 40,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertCard: {
    marginBottom: 12,
    borderColor: midnightEmber.screen.line.default,
  },
  alertTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  alertBody: {
    fontSize: 13,
    color: midnightEmber.screen.text.secondary,
    lineHeight: 18,
  },
  cardGrid: {
    gap: 12,
  },
  cardRow: {
    flexDirection: 'row',
    gap: 12,
  },
  trendLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: midnightEmber.screen.text.secondary,
    marginBottom: 8,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  sparklineRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
});
