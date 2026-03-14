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
  className?: string;
}

export function BalanceBadge({
  balance,
  held = 0,
  size = 'md',
  showHeld = false,
  coinIcon,
  className,
}: BalanceBadgeProps) {
  const sizeConfig = {
    sm: { label: 'text-xs', amount: 'text-lg', container: 'px-3 py-2', iconSize: 20 },
    md: { label: 'text-sm', amount: 'text-2xl', container: 'px-4 py-3', iconSize: 28 },
    lg: { label: 'text-base', amount: 'text-4xl', container: 'px-6 py-4', iconSize: 36 },
  }[size];

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`TriciCoin: ${formatTriciCoin(balance)}${showHeld && held > 0 ? `, held: ${formatTriciCoin(held)}` : ''}`}
      className={`
        bg-neutral-950 rounded-2xl ${sizeConfig.container}
        ${className ?? ''}
      `}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {coinIcon && (
          <Image
            source={coinIcon}
            style={{ width: sizeConfig.iconSize, height: sizeConfig.iconSize }}
            resizeMode="contain"
            accessibilityElementsHidden
          />
        )}
        <Text className={`${sizeConfig.label} text-neutral-400 font-medium`}>
          TriciCoin
        </Text>
      </View>
      <Text
        className={`${sizeConfig.amount} text-white font-extrabold mt-0.5`}
      >
        {formatTriciCoin(balance)}
      </Text>
      {showHeld && held > 0 && (
        <Text className="text-xs text-neutral-500 mt-1">
          Retenido: {formatTriciCoin(held)}
        </Text>
      )}
    </View>
  );
}
