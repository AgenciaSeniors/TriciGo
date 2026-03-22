import React, { type ComponentProps } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { colors } from '@tricigo/theme';

export interface ErrorStateProps {
  title?: string;
  description?: string;
  icon?: ComponentProps<typeof Ionicons>['name'];
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorState({
  title = 'Algo salió mal',
  description = 'No se pudo cargar la información. Intenta de nuevo.',
  icon = 'alert-circle-outline',
  onRetry,
  retryLabel = 'Reintentar',
  className,
}: ErrorStateProps) {
  return (
    <View className={`flex-1 items-center justify-center p-8 ${className ?? ''}`}>
      <View className="w-20 h-20 rounded-full bg-red-50 items-center justify-center mb-4">
        <Ionicons name={icon} size={36} color={colors.error.DEFAULT} />
      </View>
      <Text variant="body" color="primary" className="text-center mb-1 font-semibold">
        {title}
      </Text>
      <Text variant="bodySmall" color="secondary" className="text-center mb-4 px-8">
        {description}
      </Text>
      {onRetry && (
        <Pressable
          onPress={onRetry}
          className="mt-2 bg-primary-500 px-6 py-3 rounded-xl"
          accessibilityRole="button"
          accessibilityLabel={retryLabel}
        >
          <Text variant="body" color="inverse" className="font-semibold">
            {retryLabel}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
