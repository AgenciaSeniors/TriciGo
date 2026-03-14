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
  success: { bg: 'bg-success-light', text: 'text-success-dark' },
  error: { bg: 'bg-error-light', text: 'text-error-dark' },
  warning: { bg: 'bg-warning-light', text: 'text-warning-dark' },
  info: { bg: 'bg-info-light', text: 'text-info-dark' },
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
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      className={`rounded-full ${s} ${v.bg} ${className ?? ''}`}
    >
      <Text variant="caption" className={`font-medium ${v.text}`}>
        {label}
      </Text>
    </View>
  );
}
