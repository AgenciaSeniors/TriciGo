import React from 'react';
import {
  Pressable,
  Text,
  ActivityIndicator,
  type PressableProps,
} from 'react-native';
import { colors } from '@tricigo/theme';

export interface ButtonProps extends Omit<PressableProps, 'children'> {
  title: string;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  fullWidth?: boolean;
}

const variantStyles = {
  primary: {
    container: 'bg-primary-500 active:bg-primary-600',
    text: 'text-white',
  },
  secondary: {
    container: 'bg-neutral-900 active:bg-neutral-800',
    text: 'text-white',
  },
  outline: {
    container: 'border-2 border-primary-500 bg-transparent active:bg-primary-50',
    text: 'text-primary-500',
  },
  ghost: {
    container: 'bg-transparent active:bg-neutral-100',
    text: 'text-neutral-900',
  },
  danger: {
    container: 'bg-error active:bg-red-700',
    text: 'text-white',
  },
} as const;

const sizeStyles = {
  sm: { container: 'px-4 py-2 rounded-md', text: 'text-sm font-semibold' },
  md: { container: 'px-6 py-3 rounded-lg', text: 'text-base font-bold' },
  lg: { container: 'px-8 py-4 rounded-xl', text: 'text-lg font-bold' },
} as const;

export function Button({
  title,
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  disabled,
  className,
  ...props
}: ButtonProps & { className?: string }) {
  const v = variantStyles[variant];
  const s = sizeStyles[size];
  const isDisabled = disabled || loading;

  return (
    <Pressable
      className={`
        flex-row items-center justify-center
        ${s.container} ${v.container}
        ${fullWidth ? 'w-full' : ''}
        ${isDisabled ? 'opacity-50' : ''}
        ${className ?? ''}
      `}
      disabled={isDisabled}
      {...props}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === 'outline' || variant === 'ghost' ? colors.brand.orange : colors.brand.white}
          size="small"
          className="mr-2"
        />
      ) : null}
      <Text
        className={`${s.text} ${v.text} text-center`}
      >
        {title}
      </Text>
    </Pressable>
  );
}
