/**
 * EarningsHeader — extracted from apps/driver/app/(tabs)/earnings.tsx
 * for PR-A.
 *
 * Renders the screen title plus the current `driver_cash` balance with a
 * pressable affordance that navigates to the full Wallet screen.
 *
 * The `<BalanceBadge>` + AnimatedCard wrapper is kept verbatim so the
 * mount animation timing (delay=0) matches the original.
 *
 * Visual + tokens preserved verbatim from the inline version.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { useTranslation } from '@tricigo/i18n';
import { colors, driverStandardLightColors } from '@tricigo/theme';

const lt = driverStandardLightColors;

interface EarningsHeaderProps {
  balance: number;
}

export function EarningsHeader({ balance }: EarningsHeaderProps) {
  const { t } = useTranslation('driver');

  return (
    <>
      <Text variant="h3" style={{ color: lt.text.primary }} className="mb-4">
        {t('earnings.title')}
      </Text>

      <AnimatedCard delay={0}>
        <Pressable
          onPress={() => router.push('/wallet')}
          accessibilityRole="button"
          accessibilityLabel={t('wallet.open', { defaultValue: 'Abrir Wallet' })}
        >
          <BalanceBadge
            balance={balance}
            size="lg"
            className="mb-2"
          />
          <View className="flex-row items-center justify-center mb-4">
            <Ionicons name="wallet-outline" size={14} color={colors.brand.orange} />
            <Text variant="caption" color="accent" className="ml-1">
              {t('wallet.open', { defaultValue: 'Ver Wallet' })}
            </Text>
            <Ionicons name="chevron-forward" size={12} color={colors.brand.orange} />
          </View>
        </Pressable>
      </AnimatedCard>
    </>
  );
}
