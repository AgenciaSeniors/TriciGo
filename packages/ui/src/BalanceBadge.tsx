import React from 'react';
import { View, Text } from 'react-native';
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
  className?: string;
}

export function BalanceBadge({
  balance,
  held = 0,
  size = 'md',
  showHeld = false,
  className,
}: BalanceBadgeProps) {
  const sizeConfig = {
    sm: { label: 'text-xs', amount: 'text-lg', container: 'px-3 py-2' },
    md: { label: 'text-sm', amount: 'text-2xl', container: 'px-4 py-3' },
    lg: { label: 'text-base', amount: 'text-4xl', container: 'px-6 py-4' },
  }[size];

  return (
    <View
      className={`
        bg-neutral-950 rounded-2xl ${sizeConfig.container}
        ${className ?? ''}
      `}
    >
      <Text className={`${sizeConfig.label} text-neutral-400 font-medium`}>
        TriciCoin
      </Text>
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
