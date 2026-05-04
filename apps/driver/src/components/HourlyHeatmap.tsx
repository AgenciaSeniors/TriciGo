/**
 * HourlyHeatmap — Midnight Ember edition (PR-B).
 *
 * Heat-map of trips per hour (4 × 6 grid). Highlights peak hours and
 * lets the driver tap a cell to see exact count.
 *
 * v2 tokenization: the 5-step intensity ladder collapses onto the
 * accent[100..500] scale on light theme and onto translucent accent[500]
 * tints on dark theme. Selection border, peak chip background, and
 * helper text all migrate from raw hex to `midnightEmber` tokens.
 */
import React, { useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';
import type { Ride } from '@tricigo/types';

interface HourlyHeatmapProps {
  trips: Ride[];
  theme?: 'light' | 'dark';
}

const HOUR_LABELS = [
  '12am', '1am', '2am', '3am', '4am', '5am',
  '6am', '7am', '8am', '9am', '10am', '11am',
  '12pm', '1pm', '2pm', '3pm', '4pm', '5pm',
  '6pm', '7pm', '8pm', '9pm', '10pm', '11pm',
];

/**
 * Map normalized intensity (0..1) onto the accent intensity ladder. On
 * light theme we step through accent[50..500]; on dark we use
 * translucent accent[500] tints to keep readability against the deep
 * map surface.
 */
function getHeatColor(intensity: number, isLight = false): string {
  if (isLight) {
    if (intensity === 0) return midnightEmber.screen.bg.canvas;
    if (intensity < 0.25) return midnightEmber.accent[50];
    if (intensity < 0.5) return midnightEmber.accent[100];
    if (intensity < 0.75) return midnightEmber.accent[300];
    return midnightEmber.accent[500];
  }
  if (intensity === 0) return 'rgba(255,255,255,0.05)';
  if (intensity < 0.25) return `${midnightEmber.accent[500]}33`;  // ~20%
  if (intensity < 0.5)  return `${midnightEmber.accent[500]}66`;  // ~40%
  if (intensity < 0.75) return `${midnightEmber.accent[500]}A6`;  // ~65%
  return midnightEmber.accent[500];
}

export function HourlyHeatmap({ trips, theme = 'dark' }: HourlyHeatmapProps) {
  const { t } = useTranslation('driver');
  const isLight = theme === 'light';
  const [selectedHour, setSelectedHour] = useState<number | null>(null);

  const hourCounts = useMemo(() => {
    const counts = new Array(24).fill(0) as number[];
    for (const trip of trips) {
      const hour = new Date(trip.created_at).getHours();
      counts[hour] = (counts[hour] ?? 0) + 1;
    }
    return counts;
  }, [trips]);

  const maxCount = Math.max(...hourCounts, 1);

  if (trips.length === 0) return null;

  // Peak hours (top 3)
  const peakHours = hourCounts
    .map((count, hour) => ({ hour, count }))
    .filter((h) => h.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  // Theme-resolved tokens.
  const surfaceBg = isLight
    ? midnightEmber.screen.bg.surface
    : midnightEmber.map.bg.elevated;
  const surfaceBorder = isLight
    ? midnightEmber.screen.line.default
    : midnightEmber.map.line.hairline;
  const titleColor = isLight
    ? midnightEmber.screen.text.primary
    : midnightEmber.map.text.primary;
  const labelColor = isLight
    ? midnightEmber.screen.text.secondary
    : midnightEmber.map.text.secondary;
  const cellLabelColor = isLight
    ? midnightEmber.screen.text.secondary
    : 'rgba(255,255,255,0.7)';
  const cellCountColor = isLight
    ? midnightEmber.screen.text.primary
    : midnightEmber.map.text.primary;
  const selectedBorder = isLight
    ? midnightEmber.accent[500]
    : midnightEmber.map.text.primary;
  const peakChipBg = isLight
    ? midnightEmber.accent[50]
    : `${midnightEmber.accent[500]}33`; // ~20%

  return (
    <View
      className="rounded-xl p-4 mb-4"
      style={isLight
        ? {
            backgroundColor: surfaceBg,
            borderWidth: 1,
            borderColor: surfaceBorder,
            ...midnightEmber.shadow.card,
          }
        : {
            backgroundColor: surfaceBg,
            borderWidth: 1,
            borderColor: surfaceBorder,
          }
      }
    >
      <Text
        variant="bodySmall"
        className="font-semibold mb-3"
        style={{ color: titleColor }}
      >
        {t('earnings.hourly_activity', { defaultValue: 'Actividad por hora' })}
      </Text>

      {/* Heatmap grid — 4 rows x 6 columns */}
      <View className="mb-3">
        {[0, 1, 2, 3].map((row) => (
          <View key={row} className="flex-row gap-1.5 mb-1.5">
            {[0, 1, 2, 3, 4, 5].map((col) => {
              const hour = row * 6 + col;
              const intensity = hourCounts[hour]! / maxCount;
              const isSelected = selectedHour === hour;
              return (
                <Pressable
                  key={hour}
                  className="flex-1 items-center justify-center rounded-md"
                  style={{
                    height: 36,
                    backgroundColor: getHeatColor(intensity, isLight),
                    borderWidth: isSelected ? 1.5 : 0,
                    borderColor: isSelected ? selectedBorder : 'transparent',
                  }}
                  onPress={() => setSelectedHour(isSelected ? null : hour)}
                >
                  <Text
                    variant="caption"
                    className="text-[10px]"
                    style={{ color: cellLabelColor }}
                  >
                    {HOUR_LABELS[hour]}
                  </Text>
                  {hourCounts[hour]! > 0 && (
                    <Text
                      variant="caption"
                      className="text-[10px] font-bold"
                      style={{ color: cellCountColor }}
                    >
                      {hourCounts[hour]}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>

      {/* Selected hour detail */}
      {selectedHour !== null && (
        <Text
          variant="caption"
          className="text-center mb-2"
          style={{ color: midnightEmber.accent[500] }}
        >
          {HOUR_LABELS[selectedHour]}: {t('earnings.trips_at_hour', { count: hourCounts[selectedHour]!, defaultValue: `${hourCounts[selectedHour]} viajes` })}
        </Text>
      )}

      {/* Peak hours */}
      {peakHours.length > 0 && (
        <View>
          <Text
            variant="caption"
            className="mb-1.5"
            style={{ color: labelColor }}
          >
            {t('earnings.peak_hours', { defaultValue: 'Horas pico' })}
          </Text>
          <View className="flex-row gap-2 flex-wrap">
            {peakHours.map((ph) => (
              <View
                key={ph.hour}
                className="px-2.5 py-1 rounded-full"
                style={{ backgroundColor: peakChipBg }}
              >
                <Text
                  variant="caption"
                  className="font-medium"
                  style={{ color: midnightEmber.accent[500] }}
                >
                  {HOUR_LABELS[ph.hour]} ({ph.count})
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}
