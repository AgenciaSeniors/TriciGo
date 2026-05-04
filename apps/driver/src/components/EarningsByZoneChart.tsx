/**
 * EarningsByZoneChart — Midnight Ember edition (PR-B).
 *
 * Horizontal-bar mini-chart showing the driver's top zones by earnings
 * for the selected period. Pure View + width% — no SVG dependency.
 *
 * v2 tokenization: card surface, bar track, and accent fill all migrate
 * from raw hex to `midnightEmber` tokens. The skeleton state shares the
 * bar-track color with the actual bars for visual continuity.
 */
import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP } from '@tricigo/utils';
import { midnightEmber } from '@tricigo/theme';
import type { DriverEarningsByZone } from '@tricigo/types';

interface Props {
  data: DriverEarningsByZone[];
  loading?: boolean;
}

const BAR_HEIGHT = 10;

/**
 * Horizontal-bar mini-chart showing the driver's top zones by
 * earnings for the selected period. Pure View + width% — no SVG
 * dependency. Each row: zone name (left) · bar (middle) · total (right).
 * Bar proportional to the max earning in the dataset.
 */
export function EarningsByZoneChart({ data, loading }: Props) {
  const { t } = useTranslation('driver');

  const maxEarnings = useMemo(
    () => data.reduce((acc, row) => Math.max(acc, row.total_earnings_cup), 0),
    [data],
  );

  return (
    <View className="mt-4">
      <Text variant="h4" className="mb-3">
        {t('earnings.by_zone_title', { defaultValue: 'Ingresos por zona' })}
      </Text>

      <Card
        variant="filled"
        padding="md"
        style={{
          backgroundColor: midnightEmber.screen.bg.surface,
          borderWidth: 1,
          borderColor: midnightEmber.screen.line.default,
          borderRadius: midnightEmber.radius.card,
          ...midnightEmber.shadow.card,
        }}
      >
        {loading ? (
          <View className="py-2">
            {[0, 1, 2].map((i) => (
              <View key={i} className="mb-3">
                <View
                  style={{
                    height: 10,
                    width: '60%',
                    borderRadius: 4,
                    backgroundColor: midnightEmber.screen.line.hairline,
                    marginBottom: 8,
                  }}
                />
                <View
                  style={{
                    height: BAR_HEIGHT,
                    width: `${90 - i * 20}%`,
                    borderRadius: BAR_HEIGHT / 2,
                    backgroundColor: midnightEmber.screen.line.hairline,
                  }}
                />
              </View>
            ))}
          </View>
        ) : data.length === 0 ? (
          <Text variant="bodySmall" color="secondary" className="text-center py-2">
            {t('earnings.by_zone_empty', {
              defaultValue: 'Aún no hay datos suficientes por zona',
            })}
          </Text>
        ) : (
          data.map((row) => {
            const pct = maxEarnings > 0 ? (row.total_earnings_cup / maxEarnings) * 100 : 0;
            return (
              <View key={row.zone_id} className="mb-3 last:mb-0">
                <View className="flex-row justify-between mb-1">
                  <Text
                    variant="bodySmall"
                    className="font-medium flex-1"
                    numberOfLines={1}
                    style={{ color: midnightEmber.screen.text.primary }}
                  >
                    {row.zone_name}
                  </Text>
                  <Text
                    variant="bodySmall"
                    className="font-semibold tabular-nums ml-2"
                    style={{ color: midnightEmber.screen.text.primary }}
                  >
                    {formatCUP(row.total_earnings_cup)}
                  </Text>
                </View>
                <View
                  style={{
                    height: BAR_HEIGHT,
                    borderRadius: BAR_HEIGHT / 2,
                    backgroundColor: midnightEmber.screen.line.hairline,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      height: '100%',
                      width: `${pct}%`,
                      backgroundColor: midnightEmber.accent[500],
                      borderRadius: BAR_HEIGHT / 2,
                    }}
                  />
                </View>
                <Text
                  variant="caption"
                  className="mt-0.5"
                  style={{ color: midnightEmber.screen.text.secondary }}
                >
                  {t('earnings.by_zone_trips', {
                    count: row.trip_count,
                    defaultValue: `${row.trip_count} viaje${row.trip_count === 1 ? '' : 's'}`,
                  })}
                </Text>
              </View>
            );
          })
        )}
      </Card>
    </View>
  );
}
