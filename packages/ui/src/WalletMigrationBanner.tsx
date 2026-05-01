// ============================================================
// Wallet v2 phase 2: one-time announcement of the unit-of-account
// flip + 5% migration bonus. Shown above the wallet balance until
// the user dismisses it. Persistence is owned by the caller via
// AsyncStorage / localStorage so this component stays UI-only.
// ============================================================

import React from 'react';
import { View, Text, Pressable } from 'react-native';

export interface WalletMigrationBannerProps {
  /** USD-cents balance after migration (drives the bonus copy). */
  balanceUsdCents: number;
  /** Bonus % applied during migration (5 for passenger/corporate, 0 for driver). */
  bonusPct: number;
  /** Called when the user taps "Entendido" — caller persists dismissal. */
  onDismiss: () => void;
  /** Tailwind className override for the outer wrapper. */
  className?: string;
}

export function WalletMigrationBanner({
  balanceUsdCents,
  bonusPct,
  onDismiss,
  className,
}: WalletMigrationBannerProps) {
  // Driver accounts (bonus=0) get a different message — same migration but
  // we don't claim a "regalo" since they didn't pay for the TC.
  const showsBonus = bonusPct > 0;
  const bonusUsd = (balanceUsdCents / 100 / (1 + bonusPct / 100)) * (bonusPct / 100);

  return (
    <View
      className={`mb-3 rounded-2xl border border-orange-200 bg-orange-50 p-4 dark:border-orange-900/40 dark:bg-orange-950/30 ${className ?? ''}`}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={
        showsBonus
          ? `TriciCoin actualizado. Te regalamos un bono del ${bonusPct.toFixed(0)} por ciento de bienvenida.`
          : 'TriciCoin actualizado. Tu saldo ahora se muestra en USD.'
      }
    >
      <Text className="text-[13px] font-bold text-orange-900 dark:text-orange-200">
        {showsBonus ? '🎁 ¡Nuevo TriciCoin con bono!' : 'TriciCoin actualizado'}
      </Text>
      <Text
        className="mt-1 text-[12.5px] leading-[18px] text-orange-900/80 dark:text-orange-100/80"
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {showsBonus
          ? `Tu saldo ahora se muestra en USD (1 TC ≡ 1 USD). Te regalamos ~$${bonusUsd.toFixed(2)} (${bonusPct.toFixed(0)}%) como bienvenida al nuevo modelo.`
          : 'Tu saldo ahora se muestra en USD (1 TC ≡ 1 USD). Mismo importe, nueva unidad para reflejar el valor real.'}
      </Text>
      <Pressable
        onPress={onDismiss}
        className="mt-3 self-start rounded-full bg-orange-600 px-4 py-1.5 active:bg-orange-700"
        accessibilityRole="button"
        accessibilityLabel="Entendido"
      >
        <Text className="text-[12px] font-semibold text-white">Entendido</Text>
      </Pressable>
    </View>
  );
}
