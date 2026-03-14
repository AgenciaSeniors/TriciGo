import React, { forwardRef } from 'react';
import {
  View,
  TextInput,
  Text,
  type TextInputProps,
} from 'react-native';

export interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  /** Visual variant for light/dark backgrounds */
  variant?: 'light' | 'dark';
}

export const Input = forwardRef<TextInput, InputProps & { className?: string }>(
  ({ label, error, hint, leftIcon, rightIcon, variant = 'light', className, ...props }, ref) => {
    const isDark = variant === 'dark';

    const borderColor = error
      ? 'border-error'
      : isDark
        ? 'border-neutral-600'
        : 'border-neutral-200 focus:border-primary-500';

    const bgColor = isDark ? 'bg-neutral-800' : 'bg-white';
    const textColor = isDark ? 'text-white' : 'text-neutral-900';
    const labelColor = isDark ? 'text-neutral-300' : 'text-neutral-700';
    const hintColor = isDark ? 'text-neutral-400' : 'text-neutral-500';
    const placeholderColor = isDark ? '#737373' : '#A3A3A3';

    return (
      <View className={`mb-4 ${className ?? ''}`}>
        {label && (
          <Text className={`text-sm font-medium ${labelColor} mb-1.5`}>
            {label}
          </Text>
        )}
        <View
          className={`
            flex-row items-center
            border rounded-lg px-3 py-3
            ${bgColor}
            ${borderColor}
          `}
        >
          {leftIcon && <View className="mr-2">{leftIcon}</View>}
          <TextInput
            ref={ref}
            className={`flex-1 text-base ${textColor}`}
            placeholderTextColor={placeholderColor}
            accessibilityLabel={label ?? props.placeholder}
            accessibilityState={error ? { disabled: false } : undefined}
            accessibilityHint={hint ?? undefined}
            {...props}
          />
          {rightIcon && <View className="ml-2">{rightIcon}</View>}
        </View>
        {error && (
          <Text className="text-xs text-error mt-1">{error}</Text>
        )}
        {hint && !error && (
          <Text className={`text-xs ${hintColor} mt-1`}>{hint}</Text>
        )}
      </View>
    );
  },
);

Input.displayName = 'Input';
