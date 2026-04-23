import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { colors } from '@tricigo/theme';

export interface ScreenHeaderProps {
  title: string;
  /** Optional second line under the title — used for context like vehicle plate in chat. */
  subtitle?: string;
  onBack?: () => void;
  rightAction?: React.ReactNode;
  className?: string;
  /** Use on dark backgrounds — renders white text and translucent back button */
  light?: boolean;
}

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  rightAction,
  className,
  light,
}: ScreenHeaderProps) {
  return (
    <View className={`flex-row items-center mb-6 ${className ?? ''}`}>
      {onBack && (
        <Pressable
          onPress={onBack}
          className={`w-10 h-10 rounded-full items-center justify-center mr-3 ${light ? 'bg-white/20 active:bg-white/30' : 'bg-neutral-100 active:bg-neutral-200'}`}
          accessibilityLabel="Back"
          accessibilityRole="button"
        >
          <Ionicons name="arrow-back" size={20} color={light ? 'white' : colors.neutral[900]} />
        </Pressable>
      )}
      <View className="flex-1">
        <Text variant="h3" color={light ? 'inverse' : undefined}>{title}</Text>
        {subtitle ? (
          <Text
            variant="caption"
            color={light ? 'inverse' : 'secondary'}
            style={light ? { opacity: 0.8 } : undefined}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {rightAction && <View>{rightAction}</View>}
    </View>
  );
}
