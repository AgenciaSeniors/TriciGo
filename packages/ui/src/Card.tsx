import React from 'react';
import { View, type ViewProps } from 'react-native';

export interface CardProps extends ViewProps {
  variant?: 'elevated' | 'outlined' | 'filled';
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const variantClasses = {
  elevated: 'bg-white rounded-xl shadow-md',
  outlined: 'bg-white rounded-xl border border-neutral-200',
  filled: 'bg-neutral-50 rounded-xl',
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
