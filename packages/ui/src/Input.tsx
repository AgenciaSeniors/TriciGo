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
}

export const Input = forwardRef<TextInput, InputProps & { className?: string }>(
  ({ label, error, hint, leftIcon, rightIcon, className, ...props }, ref) => {
    const borderColor = error
      ? 'border-error'
      : 'border-neutral-200 focus:border-primary-500';

    return (
      <View className={`mb-4 ${className ?? ''}`}>
        {label && (
          <Text className="text-sm font-medium text-neutral-700 mb-1.5">
            {label}
          </Text>
        )}
        <View
          className={`
            flex-row items-center
            border rounded-lg px-3 py-3
            bg-white
            ${borderColor}
          `}
        >
          {leftIcon && <View className="mr-2">{leftIcon}</View>}
          <TextInput
            ref={ref}
            className="flex-1 text-base text-neutral-900"
            placeholderTextColor="#A3A3A3"
            {...props}
          />
          {rightIcon && <View className="ml-2">{rightIcon}</View>}
        </View>
        {error && (
          <Text className="text-xs text-error mt-1">{error}</Text>
        )}
        {hint && !error && (
          <Text className="text-xs text-neutral-500 mt-1">{hint}</Text>
        )}
      </View>
    );
  },
);

Input.displayName = 'Input';
