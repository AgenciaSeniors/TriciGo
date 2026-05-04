/**
 * EarningsHeader — Midnight Ember edition (PR-B).
 *
 * Title + driver_cash balance + Wallet CTA chevron. Pressable affordance
 * navigates to the full Wallet screen.
 *
 * v2 tokenization:
 *   - Title color via `midnightEmber.screen.text.primary`.
 *   - Wallet CTA icon + label via `midnightEmber.accent[500]`. The
 *     existing `<BalanceBadge>` and `<AnimatedCard>` shared components
 *     keep their internals.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';

interface EarningsHeaderProps {
  balance: number;
}

export function EarningsHeader({ balance }: EarningsHeaderProps) {
  const { t } = useTranslation('driver');

  return (
    <>
      <Text
        variant="h3"
        style={{ color: midnightEmber.screen.text.primary }}
        className="mb-4"
      >
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
            <Ionicons
              name="wallet-outline"
              size={14}
              color={midnightEmber.accent[500]}
            />
            <Text
              variant="caption"
              style={{ color: midnightEmber.accent[500], marginLeft: 4 }}
            >
              {t('wallet.open', { defaultValue: 'Ver Wallet' })}
            </Text>
            <Ionicons
              name="chevron-forward"
              size={12}
              color={midnightEmber.accent[500]}
            />
          </View>
        </Pressable>
      </AnimatedCard>
    </>
  );
}
