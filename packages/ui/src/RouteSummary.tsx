import React from 'react';
import { View } from 'react-native';
import { Text } from './Text';

export interface RouteSummaryProps {
  pickupAddress: string;
  dropoffAddress: string;
  pickupLabel?: string;
  dropoffLabel?: string;
  compact?: boolean;
  className?: string;
}

export function RouteSummary({
  pickupAddress,
  dropoffAddress,
  pickupLabel,
  dropoffLabel,
  compact = false,
  className,
}: RouteSummaryProps) {
  return (
    <View className={className ?? ''}>
      {/* Pickup */}
      <View className="flex-row items-start">
        <View className="items-center mr-3 pt-1">
          <View className="w-3 h-3 rounded-full bg-primary-500" />
          <View className="w-0.5 h-5 bg-neutral-300 my-0.5" />
          <View className="w-3 h-3 rounded-full bg-neutral-800" />
        </View>
        <View className="flex-1">
          {pickupLabel && !compact && (
            <Text variant="caption" color="secondary">{pickupLabel}</Text>
          )}
          <Text variant="bodySmall" numberOfLines={1}>{pickupAddress}</Text>
          <View className={compact ? 'h-2' : 'h-3'} />
          {dropoffLabel && !compact && (
            <Text variant="caption" color="secondary">{dropoffLabel}</Text>
          )}
          <Text variant="bodySmall" numberOfLines={1}>{dropoffAddress}</Text>
        </View>
      </View>
    </View>
  );
}
