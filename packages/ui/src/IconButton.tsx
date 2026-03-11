import React, { type ComponentProps } from 'react';
import { Pressable, type PressableProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
    bg: 'bg-neutral-200 active:bg-neutral-300',
    iconColor: colors.neutral[700],
  },
  danger: {
    bg: 'bg-red-600 active:bg-red-700',
    iconColor: colors.brand.white,
  },
  ghost: {
    bg: 'bg-transparent active:bg-neutral-100',
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
  const v = variantStyles[variant];
  const s = sizeStyles[size];

  return (
    <Pressable
      className={`rounded-full items-center justify-center ${s.container} ${v.bg} ${className ?? ''}`}
      accessibilityLabel={label}
      accessibilityRole="button"
      {...props}
    >
      <Ionicons name={icon} size={s.iconSize} color={v.iconColor} />
    </Pressable>
  );
}
