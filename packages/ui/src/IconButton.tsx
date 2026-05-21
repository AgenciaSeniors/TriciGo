import React, { type ComponentProps } from 'react';
import { Pressable, type PressableProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import { colors } from '@tricigo/theme';

export interface IconButtonProps extends Omit<PressableProps, 'children'> {
  icon: ComponentProps<typeof Ionicons>['name'];
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  className?: string;
}

const variantStyles = {
  primary: {
    bg: 'bg-primary-500 active:bg-primary-600',
    iconColor: colors.brand.white,
  },
  secondary: {
    bg: 'bg-neutral-200 active:bg-neutral-300 dark:bg-neutral-700 dark:active:bg-neutral-600',
    iconColor: colors.neutral[700],
  },
  danger: {
    bg: 'bg-error active:bg-error-dark',
    iconColor: colors.brand.white,
  },
  ghost: {
    bg: 'bg-transparent active:bg-neutral-100 dark:active:bg-white/10',
    iconColor: colors.neutral[700],
  },
} as const;

const sizeStyles = {
  sm: { container: 'w-9 h-9', iconSize: 18 },
  md: { container: 'w-11 h-11', iconSize: 22 },
  lg: { container: 'w-13 h-13', iconSize: 26 },
} as const;

export function IconButton({
  icon,
  variant = 'primary',
  size = 'md',
  label,
  className,
  ...props
}: IconButtonProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const v = variantStyles[variant];
  const s = sizeStyles[size];
  // secondary/ghost use a neutral icon that must flip with the theme
  const iconColor =
    variant === 'secondary' || variant === 'ghost'
      ? isDark
        ? colors.neutral[300]
        : colors.neutral[700]
      : v.iconColor;

  return (
    <Pressable
      className={`rounded-full items-center justify-center ${s.container} ${v.bg} ${className ?? ''}`}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!props.disabled }}
      {...props}
    >
      <Ionicons name={icon} size={s.iconSize} color={iconColor} />
    </Pressable>
  );
}
