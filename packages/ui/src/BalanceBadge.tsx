import React from 'react';
import { View, Text, Image, ImageSourcePropType } from 'react-native';
import { formatTriciCoin, formatTriciCoinUsd, formatCupApprox } from '@tricigo/utils';

export interface BalanceBadgeProps {
  /** Balance amount in CUP whole units (legacy, pre-Wallet v2). */
  balance: number;
  /** Optional held amount in CUP whole units (legacy). */
  held?: number;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Show held amount */
  showHeld?: boolean;
  /** Optional coin icon image source */
  coinIcon?: ImageSourcePropType;
  /** Optional gradient wrapper component (e.g. LinearGradient) */
  GradientComponent?: React.ComponentType<any>;
  /** Gradient colors (passed to GradientComponent) */
  gradientColors?: string[];
  /** Gradient start point */
  gradientStart?: { x: number; y: number };
  /** Gradient end point */
  gradientEnd?: { x: number; y: number };
  className?: string;
  /**
   * Wallet v2 phase 2: render the balance as USD-equivalent (1 TC ≡ 1 USD).
   * When `balanceUsdCents` is provided, the badge shows "$19.41" as the
   * primary figure plus an "≈ 10,287 CUP" muted subtitle. Falls back to
   * the legacy CUP-pegged TC display when this prop is absent.
   */
  balanceUsdCents?: number | null;
  /** Wallet v2 phase 2: held amount in USD cents (paired with balanceUsdCents). */
  heldUsdCents?: number | null;
  /** Wallet v2 phase 2: USD/CUP rate used for the CUP approximation line. */
  exchangeRate?: number | null;
}

export function BalanceBadge({
  balance,
  held = 0,
  size = 'md',
  showHeld = false,
  coinIcon,
  GradientComponent,
  gradientColors,
  gradientStart = { x: 0, y: 0 },
  gradientEnd = { x: 1, y: 1 },
  className,
  balanceUsdCents,
  heldUsdCents,
  exchangeRate,
}: BalanceBadgeProps) {
  const sizeConfig = {
    sm: { label: 'text-xs', amount: 'text-lg', container: 'px-3 py-2', iconSize: 24 },
    md: { label: 'text-sm', amount: 'text-2xl', container: 'px-4 py-3', iconSize: 28 },
    lg: { label: 'text-base', amount: 'text-4xl', container: 'px-6 py-4', iconSize: 36 },
  }[size];

  // Wallet v2 phase 2: when USD-cents is supplied, switch to USD-as-primary
  // rendering with the CUP equivalent as a muted subtitle. Legacy mode
  // (formatTriciCoin) is preserved when the new prop is absent so existing
  // call sites don't change behavior.
  //
  // BUG-wallet-desync: balance_usd_cents puede quedar en 0 o stale por
  // flows que actualizan `balance` sin tocar el USD snapshot (Stripe /
  // NETOPIA / PR #144 move / ride payments — la migración 00242 instaló
  // la columna pero no agregó trigger que mantenga sync; lo hace la 00285).
  // Mientras la migración 00285 no esté aplicada (o para accounts cuyo
  // snapshot quedó stale), preferimos el `balance` legacy CUP-pegged
  // cuando es positivo pero el USD snapshot dice 0. El modo USD real
  // solo aplica cuando ambos son coherentes.
  const hasFreshUsd = balanceUsdCents != null && balanceUsdCents > 0;
  const hasLegacyOnly = !hasFreshUsd && balance > 0;
  const isUsdMode = hasFreshUsd && !hasLegacyOnly;
  const primaryText = isUsdMode
    ? formatTriciCoinUsd(balanceUsdCents ?? 0)
    : formatTriciCoin(balance);
  const heldText = isUsdMode
    ? formatTriciCoinUsd(heldUsdCents ?? 0)
    : formatTriciCoin(held);
  const cupApprox = isUsdMode && exchangeRate != null
    ? formatCupApprox(balanceUsdCents ?? 0, exchangeRate)
    : null;

  const content = (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {coinIcon && (
          <Image
            source={coinIcon}
            style={{ width: sizeConfig.iconSize, height: sizeConfig.iconSize }}
            resizeMode="contain"
            accessibilityElementsHidden
          />
        )}
        <Text className={`${sizeConfig.label} text-white/70 font-medium`}>
          TriciCoin
        </Text>
      </View>
      <Text
        className={`${sizeConfig.amount} text-white font-extrabold mt-0.5`}
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {primaryText}
      </Text>
      {cupApprox && (
        <Text className="text-xs text-white/60 mt-0.5" style={{ fontVariant: ['tabular-nums'] }}>
          {cupApprox}
        </Text>
      )}
      {showHeld && (isUsdMode ? (heldUsdCents ?? 0) > 0 : held > 0) && (
        <Text className="text-xs text-white/50 mt-1" style={{ fontVariant: ['tabular-nums'] }}>
          Retenido: {heldText}
        </Text>
      )}
    </>
  );

  const containerClass = `rounded-2xl ${sizeConfig.container} ${className ?? ''}`;

  if (GradientComponent && gradientColors) {
    return (
      <GradientComponent
        colors={gradientColors}
        start={gradientStart}
        end={gradientEnd}
        style={{ borderRadius: 16, overflow: 'hidden' }}
        className={containerClass}
        accessible
        accessibilityRole="text"
        accessibilityLabel={`TriciCoin: ${primaryText}${cupApprox ? `, ${cupApprox}` : ''}${showHeld && (isUsdMode ? (heldUsdCents ?? 0) > 0 : held > 0) ? `, retenido ${heldText}` : ''}`}
      >
        {content}
      </GradientComponent>
    );
  }

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`TriciCoin: ${primaryText}${cupApprox ? `, ${cupApprox}` : ''}${showHeld && (isUsdMode ? (heldUsdCents ?? 0) > 0 : held > 0) ? `, retenido ${heldText}` : ''}`}
      className={`bg-neutral-950 ${containerClass}`}
    >
      {content}
    </View>
  );
}
