import React from 'react';
import { View } from 'react-native';
import { Text } from './Text';

export interface StatusBadgeProps {
  label: string;
  variant: 'success' | 'error' | 'warning' | 'info' | 'neutral';
  size?: 'sm' | 'md';
  className?: string;
}

const variantClasses = {
  success: { bg: 'bg-green-100', text: 'text-green-700' },
  error: { bg: 'bg-red-100', text: 'text-red-700' },
  warning: { bg: 'bg-yellow-100', text: 'text-yellow-700' },
  info: { bg: 'bg-blue-100', text: 'text-blue-700' },
  neutral: { bg: 'bg-neutral-100', text: 'text-neutral-600' },
} as const;

const sizeClasses = {
  sm: 'px-2 py-0.5',
  md: 'px-2.5 py-1',
} as const;

export function StatusBadge({
  label,
  variant,
  size = 'sm',
  className,
}: StatusBadgeProps) {
  const v = variantClasses[variant];
  const s = sizeClasses[size];

  return (
    <View className={`rounded-full ${s} ${v.bg} ${className ?? ''}`}>
      <Text variant="caption" className={`font-medium ${v.text}`}>
        {label}
      </Text>
    </View>
  );
}
