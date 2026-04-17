import React, { useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
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

function getHeatColor(intensity: number, isLight = false): string {
  if (isLight) {
    if (intensity === 0) return '#F8FAFC';
    if (intensity < 0.25) return '#FFF3ED';
    if (intensity < 0.5) return '#FFDCC8';
    if (intensity < 0.75) return '#FF9A66';
    return colors.brand.orange;
  }
  if (intensity === 0) return 'rgba(255,255,255,0.05)';
  if (intensity < 0.25) return 'rgba(249,115,22,0.2)';
  if (intensity < 0.5) return 'rgba(249,115,22,0.4)';
  if (intensity < 0.75) return 'rgba(249,115,22,0.65)';
  return colors.brand.orange;
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

  return (
    <View
      className="rounded-xl p-4 mb-4"
      style={isLight
        ? { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 }
        : { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }
      }
    >
      <Text variant="bodySmall" className="font-semibold mb-3" style={{ color: isLight ? '#0F172A' : '#FFFFFF' }}>
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
                    borderColor: isSelected ? (isLight ? '#FF4D00' : '#fff') : 'transparent',
                  }}
                  onPress={() => setSelectedHour(isSelected ? null : hour)}
                >
                  <Text
                    variant="caption"
                    className="text-[10px]"
                    style={{ color: isLight ? '#64748B' : 'rgba(255,255,255,0.7)' }}
                  >
                    {HOUR_LABELS[hour]}
                  </Text>
                  {hourCounts[hour]! > 0 && (
                    <Text variant="caption" className="text-[10px] font-bold" style={{ color: isLight ? '#0F172A' : '#FFFFFF' }}>
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
          <Text variant="caption" className="mb-1.5" style={{ color: isLight ? '#64748B' : 'rgba(255,255,255,0.5)' }}>
            {t('earnings.peak_hours', { defaultValue: 'Horas pico' })}
          </Text>
          <View className="flex-row gap-2 flex-wrap">
            {peakHours.map((ph) => (
              <View key={ph.hour} style={{ backgroundColor: isLight ? '#FFF3ED' : 'rgba(249,115,22,0.2)' }} className="px-2.5 py-1 rounded-full">
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
