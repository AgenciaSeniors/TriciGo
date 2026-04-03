import React, { type ComponentProps } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { colors } from '@tricigo/theme';

export interface StatCardProps {
  /** Icon name from Ionicons */
  icon: ComponentProps<typeof Ionicons>['name'];
  /** The metric value (e.g., "$45.50", "4.9", "12") */
  value: string;
  /** Label below the value */
  label: string;
  /** Optional trend indicator */
  trend?: { direction: 'up' | 'down' | 'neutral'; label: string };
  /** Icon color override (defaults to Go Orange) */
  iconColor?: string;
  className?: string;
}

export function StatCard({
  icon,
  value,
  label,
  trend,
  iconColor = colors.brand.orange,
  className,
}: StatCardProps) {
  const trendColor =
    trend?.direction === 'up'
      ? 'text-green-400'
      : trend?.direction === 'down'
        ? 'text-red-400'
        : 'text-neutral-400';
  const trendIcon =
    trend?.direction === 'up'
      ? 'trending-up'
      : trend?.direction === 'down'
        ? 'trending-down'
        : 'remove';

  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLabel={`${label}: ${value}${trend ? `, ${trend.label}` : ''}`}
      className={`bg-[#1a1a2e] rounded-2xl border border-white/6 p-4 ${className ?? ''}`}
    >
      <View className="flex-row items-center mb-2">
        <View className="w-8 h-8 rounded-lg bg-[#252540] items-center justify-center">
          <Ionicons name={icon} size={16} color={iconColor} />
        </View>
      </View>
      <Text variant="metric" color="inverse" className="mb-0.5">
        {value}
      </Text>
      <Text variant="caption" color="secondary">
        {label}
      </Text>
      {trend && (
        <View className="flex-row items-center mt-1.5">
          <Ionicons name={trendIcon as any} size={12} color={trendColor === 'text-green-400' ? '#4ADE80' : trendColor === 'text-red-400' ? '#F87171' : '#9CA3AF'} />
          <Text variant="badge" className={`ml-1 ${trendColor}`}>
            {trend.label}
          </Text>
        </View>
      )}
    </View>
  );
}
