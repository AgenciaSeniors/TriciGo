import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { colors } from '@tricigo/theme';

export interface ScreenHeaderProps {
  title: string;
  onBack?: () => void;
  rightAction?: React.ReactNode;
  className?: string;
}

export function ScreenHeader({
  title,
  onBack,
  rightAction,
  className,
}: ScreenHeaderProps) {
  return (
    <View className={`flex-row items-center mb-6 ${className ?? ''}`}>
      {onBack && (
        <Pressable
          onPress={onBack}
          className="w-10 h-10 rounded-full bg-neutral-100 items-center justify-center mr-3 active:bg-neutral-200"
          accessibilityLabel="Volver"
          accessibilityRole="button"
        >
          <Ionicons name="arrow-back" size={20} color={colors.neutral[900]} />
        </Pressable>
      )}
      <Text variant="h3" className="flex-1">{title}</Text>
      {rightAction && <View>{rightAction}</View>}
    </View>
  );
}
