import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import type { DriverEarningsByZone } from '@tricigo/types';

interface Props {
  data: DriverEarningsByZone[];
  loading?: boolean;
}

const BAR_HEIGHT = 10;
const CARD_BG = '#ffffff';
const BORDER_SUBTLE = 'rgba(15, 23, 42, 0.06)';
const BAR_TRACK = 'rgba(15, 23, 42, 0.05)';

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
        style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16 }}
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
                    backgroundColor: BAR_TRACK,
                    marginBottom: 8,
                  }}
                />
                <View
                  style={{
                    height: BAR_HEIGHT,
                    width: `${90 - i * 20}%`,
                    borderRadius: BAR_HEIGHT / 2,
                    backgroundColor: BAR_TRACK,
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
                  <Text variant="bodySmall" className="font-medium flex-1" numberOfLines={1}>
                    {row.zone_name}
                  </Text>
                  <Text variant="bodySmall" className="font-semibold tabular-nums ml-2">
                    {formatCUP(row.total_earnings_cup)}
                  </Text>
                </View>
                <View
                  style={{
                    height: BAR_HEIGHT,
                    borderRadius: BAR_HEIGHT / 2,
                    backgroundColor: BAR_TRACK,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      height: '100%',
                      width: `${pct}%`,
                      backgroundColor: colors.brand.orange,
                      borderRadius: BAR_HEIGHT / 2,
                    }}
                  />
                </View>
                <Text variant="caption" color="secondary" className="mt-0.5">
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
