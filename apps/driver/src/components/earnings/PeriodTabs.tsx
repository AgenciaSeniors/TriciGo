/**
 * PeriodTabs — Midnight Ember edition (PR-B).
 *
 * Pill-shaped tab row: `Hoy / Semana / Mes`.
 *
 * v2 tokenization: active tab background swapped from a raw `#FF4D00`
 * to `midnightEmber.accent[500]`; the inactive background uses
 * `screen.bg.sunken` and the inactive label uses
 * `screen.text.secondary` so the interactive contrast follows the
 * system instead of a hard-coded hex pair.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';

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
    <View
      className="flex-row gap-2 mb-4"
      accessibilityRole="tablist"
    >
      {(['day', 'week', 'month'] as Period[]).map((p) => {
        const active = period === p;
        return (
          <Pressable
            key={p}
            onPress={() => onChange(p)}
            className="flex-1 min-h-[48px] justify-center rounded-full items-center"
            style={{
              backgroundColor: active
                ? midnightEmber.accent[500]
                : midnightEmber.screen.bg.sunken,
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={labels[p]}
          >
            <Text
              variant="bodySmall"
              className="font-semibold"
              style={{
                color: active
                  ? midnightEmber.screen.text.inverse
                  : midnightEmber.screen.text.secondary,
              }}
            >
              {labels[p]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
