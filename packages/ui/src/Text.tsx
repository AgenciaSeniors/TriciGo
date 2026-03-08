import React from 'react';
import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

export interface TextProps extends RNTextProps {
  variant?: 'h1' | 'h2' | 'h3' | 'h4' | 'body' | 'bodySmall' | 'caption' | 'label';
  color?: 'primary' | 'secondary' | 'tertiary' | 'inverse' | 'accent' | 'error';
}

const variantClasses = {
  h1: 'text-4xl font-extrabold',
  h2: 'text-3xl font-bold',
  h3: 'text-2xl font-bold',
  h4: 'text-xl font-semibold',
  body: 'text-base font-normal',
  bodySmall: 'text-sm font-normal',
  caption: 'text-xs font-medium',
  label: 'text-sm font-medium',
} as const;

const colorClasses = {
  primary: 'text-neutral-950',
  secondary: 'text-neutral-600',
  tertiary: 'text-neutral-400',
  inverse: 'text-white',
  accent: 'text-primary-500',
  error: 'text-error',
} as const;

export function Text({
  variant = 'body',
  color = 'primary',
  className,
  children,
  ...props
}: TextProps & { className?: string }) {
  return (
    <RNText
      className={`
        ${variantClasses[variant]}
        ${colorClasses[color]}
        ${className ?? ''}
      `}
      {...props}
    >
      {children}
    </RNText>
  );
}
