import React, { type ComponentProps } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';

export interface StatusBadgeProps {
  label: string;
  variant: 'success' | 'error' | 'warning' | 'info' | 'neutral';
  /** Optional icon to pair with the label (accessible: never color-only) */
  icon?: ComponentProps<typeof Ionicons>['name'];
  size?: 'sm' | 'md';
  className?: string;
}

const variantConfig = {
  success: {
    bg: 'bg-green-900/40',
    text: 'text-green-400',
    iconColor: '#4ADE80',
    defaultIcon: 'checkmark-circle' as const,
  },
  error: {
    bg: 'bg-red-900/40',
    text: 'text-red-400',
    iconColor: '#F87171',
    defaultIcon: 'close-circle' as const,
  },
  warning: {
    bg: 'bg-yellow-900/40',
    text: 'text-yellow-400',
    iconColor: '#FBBF24',
    defaultIcon: 'alert-circle' as const,
  },
  info: {
    bg: 'bg-blue-900/40',
    text: 'text-blue-400',
    iconColor: '#60A5FA',
    defaultIcon: 'information-circle' as const,
  },
  neutral: {
    bg: 'bg-neutral-700/60',
    text: 'text-neutral-400',
    iconColor: '#9CA3AF',
    defaultIcon: 'ellipse' as const,
  },
} as const;

const sizeClasses = {
  sm: 'px-2.5 py-1',
  md: 'px-3 py-1.5',
} as const;

export function StatusBadge({
  label,
  variant,
  icon,
  size = 'sm',
  className,
}: StatusBadgeProps) {
  const v = variantConfig[variant];
  const s = sizeClasses[size];
  const iconName = icon ?? v.defaultIcon;
  const iconSize = size === 'sm' ? 12 : 14;

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      className={`flex-row items-center rounded-full ${s} ${v.bg} ${className ?? ''}`}
    >
      <Ionicons name={iconName} size={iconSize} color={v.iconColor} />
      <Text variant="badge" className={`ml-1 ${v.text}`}>
        {label}
      </Text>
    </View>
  );
}
