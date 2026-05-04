/**
 * PeriodTabs — extracted from apps/driver/app/(tabs)/earnings.tsx
 * for PR-A.
 *
 * Pill-shaped tab row: `Hoy / Semana / Mes`. Triggers the parent's
 * `period` state change which in turn refetches data via the
 * earnings hook.
 *
 * Visual + tokens preserved verbatim. Migration to midnightEmber
 * happens in PR-B.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { driverStandardLightColors } from '@tricigo/theme';

const lt = driverStandardLightColors;

export type Period = 'day' | 'week' | 'month';

interface PeriodTabsProps {
  period: Period;
  onChange: (p: Period) => void;
}

export function PeriodTabs({ period, onChange }: PeriodTabsProps) {
  const { t } = useTranslation('driver');

  const labels: Record<Period, string> = {
    day: t('earnings.today', { defaultValue: 'Hoy' }),
    week: t('earnings.week', { defaultValue: 'Semana' }),
    month: t('earnings.month', { defaultValue: 'Mes' }),
  };

  return (
    <View className="flex-row gap-2 mb-4" accessibilityRole="tablist">
      {(['day', 'week', 'month'] as Period[]).map((p) => (
        <Pressable
          key={p}
          onPress={() => onChange(p)}
          className="flex-1 min-h-[48px] justify-center rounded-full items-center"
          style={period === p
            ? { backgroundColor: '#FF4D00' }
            : { backgroundColor: lt.background.tertiary }
          }
          accessibilityRole="tab"
          accessibilityState={{ selected: period === p }}
          accessibilityLabel={labels[p]}
        >
          <Text
            variant="bodySmall"
            className="font-semibold"
            style={{ color: period === p ? '#FFFFFF' : lt.text.secondary }}
          >
            {labels[p]}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
