import React from 'react';
import { View, type ViewProps } from 'react-native';

export interface CardProps extends ViewProps {
  variant?: 'elevated' | 'outlined' | 'filled' | 'surface';
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const variantClasses = {
  elevated: 'bg-white dark:bg-neutral-800 rounded-2xl shadow-lg border border-transparent dark:border-white/6',
  outlined: 'bg-white dark:bg-neutral-800 rounded-2xl border border-neutral-200 dark:border-white/12',
  filled: 'bg-neutral-50 dark:bg-neutral-800 rounded-2xl',
  /** Dark premium surface card with subtle border */
  surface: 'bg-[#1a1a2e] rounded-2xl border border-white/6',
} as const;

const paddingClasses = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
} as const;

export function Card({
  variant = 'elevated',
  padding = 'md',
  className,
  children,
  ...props
}: CardProps & { className?: string }) {
  return (
    <View
      accessible
      accessibilityRole="summary"
      className={`
        ${variantClasses[variant]}
        ${paddingClasses[padding]}
        ${className ?? ''}
      `}
      {...props}
    >
      {children}
    </View>
  );
}
