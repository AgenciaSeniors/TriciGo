import React from 'react';
import { View, useColorScheme, type ViewProps, type ViewStyle } from 'react-native';

export interface CardProps extends ViewProps {
  variant?: 'elevated' | 'outlined' | 'filled' | 'surface';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Force dark background mode (dark card on dark bg) */
  forceDark?: boolean;
}

const variantClasses = {
  elevated: 'bg-white dark:bg-neutral-800 rounded-2xl shadow-lg border border-transparent dark:border-white/6',
  outlined: 'bg-white dark:bg-neutral-800 rounded-2xl border border-neutral-200 dark:border-white/12',
  filled: 'bg-neutral-50 dark:bg-neutral-800 rounded-2xl',
  /** Dark premium surface card with subtle border */
  surface: 'bg-neutral-100 dark:bg-neutral-800 rounded-2xl border border-neutral-200 dark:border-white/6',
} as const;

/** Inline dark styles for forceDark mode (bypasses NativeWind class system) */
const forceDarkStyles: Record<string, ViewStyle> = {
  elevated: { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  outlined: { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  filled: { backgroundColor: '#1a1a2e' },
  surface: { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
};

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
  forceDark = false,
  style,
  ...props
}: CardProps & { className?: string }) {
  const colorScheme = useColorScheme();
  const isDark = forceDark || colorScheme === 'dark';

  return (
    <View
      accessible
      accessibilityRole="summary"
      className={`
        ${variantClasses[variant]}
        ${paddingClasses[padding]}
        ${className ?? ''}
      `}
      style={[forceDark ? forceDarkStyles[variant] : undefined, style as ViewStyle]}
      {...props}
    >
      {children}
    </View>
  );
}
