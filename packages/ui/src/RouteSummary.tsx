import React from 'react';
import { View } from 'react-native';
import { Text } from './Text';

export interface RouteSummaryProps {
  pickupAddress: string;
  dropoffAddress: string;
  pickupLabel?: string;
  dropoffLabel?: string;
  /** Intermediate waypoints between pickup and dropoff */
  waypoints?: Array<{ address: string; label?: string }>;
  compact?: boolean;
  className?: string;
}

export function RouteSummary({
  pickupAddress,
  dropoffAddress,
  pickupLabel,
  dropoffLabel,
  waypoints = [],
  compact = false,
  className,
}: RouteSummaryProps) {
  const a11yLabel = [
    pickupAddress,
    ...waypoints.map((wp) => wp.address),
    dropoffAddress,
  ].join(' → ');

  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLabel={a11yLabel}
      className={className ?? ''}
    >
      {/* Pickup */}
      <View className="flex-row items-start">
        <View className="items-center mr-3 pt-1">
          <View className="w-3 h-3 rounded-full bg-green-500" />
          <View className="w-0.5 h-5 bg-neutral-300 my-0.5" style={{ borderStyle: 'dashed' }} />
        </View>
        <View className="flex-1">
          {pickupLabel && !compact && (
            <Text variant="caption" color="secondary">{pickupLabel}</Text>
          )}
          <Text variant="bodySmall" numberOfLines={1}>{pickupAddress}</Text>
          {waypoints.length === 0 && <View className={compact ? 'h-2' : 'h-3'} />}
        </View>
      </View>

      {/* Waypoints */}
      {waypoints.map((wp, index) => (
        <View key={`wp-${index}`} className="flex-row items-start">
          <View className="items-center mr-3 pt-1">
            <View className="w-2.5 h-2.5 rounded-full bg-primary-400 ml-[1px]" />
            <View className="w-0.5 h-5 bg-neutral-300 my-0.5 ml-[1px]" />
          </View>
          <View className="flex-1">
            {wp.label && !compact && (
              <Text variant="caption" color="accent">{wp.label}</Text>
            )}
            <Text variant="bodySmall" numberOfLines={1}>{wp.address}</Text>
          </View>
        </View>
      ))}

      {/* Dropoff */}
      <View className="flex-row items-start">
        <View className="items-center mr-3 pt-1">
          <View className="w-3 h-3 rounded-full bg-red-500" />
        </View>
        <View className="flex-1">
          {dropoffLabel && !compact && (
            <Text variant="caption" color="secondary">{dropoffLabel}</Text>
          )}
          <Text variant="bodySmall" numberOfLines={1}>{dropoffAddress}</Text>
        </View>
      </View>
    </View>
  );
}
