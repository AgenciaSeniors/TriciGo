import React, { type ComponentProps } from 'react';
import { View, useColorScheme } from 'react-native';
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
  /** Force dark background mode (dark card on dark bg) */
  forceDark?: boolean;
  className?: string;
}

export function StatCard({
  icon,
  value,
  label,
  trend,
  iconColor = colors.brand.orange,
  forceDark = false,
  className,
}: StatCardProps) {
  const colorScheme = useColorScheme();
  const isDark = forceDark || colorScheme === 'dark';

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
      className={`rounded-2xl p-4 ${className ?? ''}`}
      style={
        forceDark
          ? { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }
          : undefined
      }
    >
      <View className="flex-row items-center mb-2">
        <View
          className="w-8 h-8 rounded-lg items-center justify-center"
          style={forceDark ? { backgroundColor: '#252540' } : { backgroundColor: isDark ? '#252540' : colors.neutral[200] }}
        >
          <Ionicons name={icon} size={16} color={iconColor} />
        </View>
      </View>
      <Text variant="metric" style={forceDark ? { color: '#f5f5f5' } : undefined} className="mb-0.5">
        {value}
      </Text>
      <Text variant="caption" color="secondary" style={forceDark ? { color: colors.neutral[400] } : undefined}>
        {label}
      </Text>
      {trend && (
        <View className="flex-row items-center mt-1.5">
          <Ionicons name={trendIcon as any} size={12} color={trendColor === 'text-green-400' ? colors.success.DEFAULT : trendColor === 'text-red-400' ? colors.error.DEFAULT : colors.neutral[400]} />
          <Text variant="badge" className={`ml-1 ${trendColor}`}>
            {trend.label}
          </Text>
        </View>
      )}
    </View>
  );
}
