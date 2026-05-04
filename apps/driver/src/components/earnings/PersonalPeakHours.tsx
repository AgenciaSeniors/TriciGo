/**
 * PersonalPeakHours — Phase 2 N2.
 *
 * 7 × 24 heatmap of the driver's personal earnings by day-of-week ×
 * hour-of-day for the last 30 days. Different from the existing
 * `<HourlyHeatmap>` (which shows current-period TRIP COUNT for the
 * selected period) — this one shows the driver's HISTORICAL EARNINGS
 * pattern so they know "Friday 7pm makes me 40% more than my average".
 *
 * Data comes from `useDriverPeakHours` -> `get_driver_peak_hours_personal`
 * RPC (migration 00258).
 *
 * Cell color intensity scales with earnings relative to the driver's
 * own peak — gives them a personal map, not a platform-wide one. Cells
 * with zero earnings render as a faint hairline so the grid stays
 * legible even on slow weeks.
 *
 * Renders nothing when there's not enough data (< 5 distinct cells with
 * earnings) — drivers in their first week shouldn't see a near-empty
 * grid that misleads them.
 */
import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP } from '@tricigo/utils';
import { midnightEmber } from '@tricigo/theme';
import type { DriverPeakHourCell } from '@tricigo/types';

interface Props {
  data: DriverPeakHourCell[];
  loading: boolean;
}

const DOW_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

const surfaceStyle = {
  backgroundColor: midnightEmber.screen.bg.surface,
  borderWidth: 1,
  borderColor: midnightEmber.screen.line.default,
  borderRadius: midnightEmber.radius.card,
  ...midnightEmber.shadow.card,
};

/** Map normalized intensity (0..1) onto the accent intensity ladder. */
function getCellColor(intensity: number): string {
  if (intensity === 0) return midnightEmber.screen.line.hairline;
  if (intensity < 0.25) return midnightEmber.accent[50];
  if (intensity < 0.5) return midnightEmber.accent[100];
  if (intensity < 0.75) return midnightEmber.accent[300];
  return midnightEmber.accent[500];
}

export function PersonalPeakHours({ data, loading }: Props) {
  const { t } = useTranslation('driver');

  // Build a Map keyed by `${dow}-${hour}` for O(1) lookup while rendering.
  const byKey = useMemo(() => {
    const m = new Map<string, DriverPeakHourCell>();
    for (const row of data) {
      m.set(`${row.day_of_week}-${row.hour_of_day}`, row);
    }
    return m;
  }, [data]);

  const maxEarnings = useMemo(
    () => data.reduce((acc, r) => Math.max(acc, r.total_earnings_cup), 0),
    [data],
  );

  // Top 1 cell drives the headline insight ("Tu mejor hora: viernes 7pm — $X")
  const peak = useMemo(() => {
    if (data.length === 0) return null;
    return data.reduce((acc, r) => (r.total_earnings_cup > acc.total_earnings_cup ? r : acc));
  }, [data]);

  // Don't render the section while loading the first time, or when the
  // dataset is too thin to be useful. Driver in first week shouldn't
  // see a near-empty grid that misleads them.
  if (loading) return null;
  if (data.length < 5) return null;

  const peakDow = peak ? DOW_KEYS[peak.day_of_week] : null;
  const peakHourLabel = peak
    ? new Date(2000, 0, 1, peak.hour_of_day).toLocaleTimeString([], {
        hour: 'numeric',
        hour12: true,
      })
    : null;

  return (
    <View className="mt-4">
      <Text variant="h4" style={{ color: midnightEmber.screen.text.primary, marginBottom: 4 }}>
        {t('earnings.peak_hours_personal_title', { defaultValue: 'Tus mejores horas' })}
      </Text>
      {peak && peakDow && peakHourLabel && (
        <Text
          variant="caption"
          style={{ color: midnightEmber.screen.text.secondary, marginBottom: 12 }}
        >
          {t('earnings.peak_hours_personal_insight', {
            day: t(`earnings.dow_${peakDow}`, { defaultValue: peakDow }),
            hour: peakHourLabel,
            amount: formatCUP(peak.total_earnings_cup),
            defaultValue: `Tu mejor turno: ${t(`earnings.dow_${peakDow}`, { defaultValue: peakDow })} ${peakHourLabel} (${formatCUP(peak.total_earnings_cup)})`,
          })}
        </Text>
      )}

      <View style={surfaceStyle as any}>
        <View style={{ padding: 12 }}>
          {/* Hour-axis labels — 4 anchors (12am / 6am / 12pm / 6pm) */}
          <View style={{ flexDirection: 'row', marginLeft: 32, marginBottom: 4 }}>
            {[0, 6, 12, 18].map((h) => (
              <View
                key={h}
                style={{
                  flex: 1,
                  alignItems: 'flex-start',
                }}
              >
                <Text
                  variant="caption"
                  style={{
                    fontSize: 9,
                    color: midnightEmber.screen.text.tertiary,
                  }}
                >
                  {h === 0 ? '12am' : h === 12 ? '12pm' : h > 12 ? `${h - 12}pm` : `${h}am`}
                </Text>
              </View>
            ))}
          </View>

          {/* 7 rows × 24 cells */}
          {DOW_KEYS.map((dowKey, dowIdx) => (
            <View
              key={dowKey}
              style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}
            >
              {/* DOW label */}
              <View style={{ width: 28 }}>
                <Text
                  variant="caption"
                  style={{
                    fontSize: 10,
                    color: midnightEmber.screen.text.secondary,
                    textTransform: 'uppercase',
                    fontWeight: '600',
                  }}
                >
                  {t(`earnings.dow_short_${dowKey}`, { defaultValue: dowKey.slice(0, 2) })}
                </Text>
              </View>
              {/* 24 hour cells */}
              <View style={{ flex: 1, flexDirection: 'row', gap: 1 }}>
                {HOURS.map((h) => {
                  const cell = byKey.get(`${dowIdx}-${h}`);
                  const intensity = maxEarnings > 0 && cell
                    ? cell.total_earnings_cup / maxEarnings
                    : 0;
                  return (
                    <View
                      key={h}
                      style={{
                        flex: 1,
                        height: 14,
                        borderRadius: 2,
                        backgroundColor: getCellColor(intensity),
                      }}
                    />
                  );
                })}
              </View>
            </View>
          ))}

          {/* Legend — 4 swatches: ninguno / poco / medio / alto */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'flex-end',
              marginTop: 8,
              gap: 4,
            }}
          >
            <Text
              variant="caption"
              style={{ fontSize: 9, color: midnightEmber.screen.text.tertiary, marginRight: 4 }}
            >
              {t('earnings.peak_hours_legend_low', { defaultValue: 'Menos' })}
            </Text>
            {[0, 0.25, 0.5, 0.75, 1].map((step) => (
              <View
                key={step}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  backgroundColor: getCellColor(step),
                }}
              />
            ))}
            <Text
              variant="caption"
              style={{ fontSize: 9, color: midnightEmber.screen.text.tertiary, marginLeft: 4 }}
            >
              {t('earnings.peak_hours_legend_high', { defaultValue: 'Más' })}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}
