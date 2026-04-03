import React from 'react';
import { View, Text, Image, ImageSourcePropType } from 'react-native';
import { formatTriciCoin } from '@tricigo/utils';

export interface BalanceBadgeProps {
  /** Balance amount in centavos */
  balance: number;
  /** Optional held amount in centavos */
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
}: BalanceBadgeProps) {
  const sizeConfig = {
    sm: { label: 'text-xs', amount: 'text-lg', container: 'px-3 py-2', iconSize: 20 },
    md: { label: 'text-sm', amount: 'text-2xl', container: 'px-4 py-3', iconSize: 28 },
    lg: { label: 'text-base', amount: 'text-4xl', container: 'px-6 py-4', iconSize: 36 },
  }[size];

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
      >
        {formatTriciCoin(balance)}
      </Text>
      {showHeld && held > 0 && (
        <Text className="text-xs text-white/50 mt-1">
          Retenido: {formatTriciCoin(held)}
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
        accessibilityLabel={`TriciCoin: ${formatTriciCoin(balance)}${showHeld && held > 0 ? `, held: ${formatTriciCoin(held)}` : ''}`}
      >
        {content}
      </GradientComponent>
    );
  }

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`TriciCoin: ${formatTriciCoin(balance)}${showHeld && held > 0 ? `, held: ${formatTriciCoin(held)}` : ''}`}
      className={`bg-neutral-950 ${containerClass}`}
    >
      {content}
    </View>
  );
}
