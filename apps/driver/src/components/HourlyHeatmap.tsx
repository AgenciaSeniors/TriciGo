import React, { useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import type { Ride } from '@tricigo/types';

interface HourlyHeatmapProps {
  trips: Ride[];
}

const HOUR_LABELS = [
  '12am', '1am', '2am', '3am', '4am', '5am',
  '6am', '7am', '8am', '9am', '10am', '11am',
  '12pm', '1pm', '2pm', '3pm', '4pm', '5pm',
  '6pm', '7pm', '8pm', '9pm', '10pm', '11pm',
];

function getHeatColor(intensity: number): string {
  if (intensity === 0) return 'rgba(255,255,255,0.05)';
  if (intensity < 0.25) return 'rgba(249,115,22,0.2)';
  if (intensity < 0.5) return 'rgba(249,115,22,0.4)';
  if (intensity < 0.75) return 'rgba(249,115,22,0.65)';
  return colors.brand.orange;
}

export function HourlyHeatmap({ trips }: HourlyHeatmapProps) {
  const { t } = useTranslation('driver');
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

  return (
    <View className="bg-[#1a1a2e] border border-white/6 rounded-xl p-4 mb-4">
      <Text variant="bodySmall" color="inverse" className="font-semibold mb-3">
        {t('earnings.hourly_activity', { defaultValue: 'Actividad por hora' })}
      </Text>

      {/* Heatmap grid — 4 rows × 6 columns */}
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
                    backgroundColor: getHeatColor(intensity),
                    borderWidth: isSelected ? 1.5 : 0,
                    borderColor: isSelected ? '#fff' : 'transparent',
                  }}
                  onPress={() => setSelectedHour(isSelected ? null : hour)}
                >
                  <Text
                    variant="caption"
                    color="inverse"
                    className="text-[10px] opacity-70"
                  >
                    {HOUR_LABELS[hour]}
                  </Text>
                  {hourCounts[hour]! > 0 && (
                    <Text variant="caption" color="inverse" className="text-[10px] font-bold">
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
        <Text variant="caption" color="accent" className="text-center mb-2">
          {HOUR_LABELS[selectedHour]}: {t('earnings.trips_at_hour', { count: hourCounts[selectedHour]!, defaultValue: `${hourCounts[selectedHour]} viajes` })}
        </Text>
      )}

      {/* Peak hours */}
      {peakHours.length > 0 && (
        <View>
          <Text variant="caption" color="inverse" className="opacity-50 mb-1.5">
            {t('earnings.peak_hours', { defaultValue: 'Horas pico' })}
          </Text>
          <View className="flex-row gap-2 flex-wrap">
            {peakHours.map((ph) => (
              <View key={ph.hour} className="bg-primary-500/20 px-2.5 py-1 rounded-full">
                <Text variant="caption" color="accent" className="font-medium">
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
