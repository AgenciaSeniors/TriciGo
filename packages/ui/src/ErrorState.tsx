import React, { type ComponentProps } from 'react';
import { View, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { Button } from './Button';
import { colors } from '@tricigo/theme'; // eslint-disable-line @typescript-eslint/no-unused-vars -- used in style

export interface ErrorStateProps {
  title?: string;
  description?: string;
  icon?: ComponentProps<typeof Ionicons>['name'];
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
  /** Force dark background mode (light text on dark bg) */
  forceDark?: boolean;
}

export function ErrorState({
  title = 'Algo salió mal',
  description = 'No se pudo cargar la información. Intenta de nuevo.',
  icon = 'alert-circle-outline',
  onRetry,
  retryLabel = 'Reintentar',
  className,
  forceDark = false,
}: ErrorStateProps) {
  const colorScheme = useColorScheme();
  const isDark = forceDark || colorScheme === 'dark';

  return (
    <View className={`flex-1 items-center justify-center p-8 ${className ?? ''}`}>
      {/* Double-ring error icon with subtle red glow */}
      <View
        className="items-center justify-center mb-5"
        style={{
          width: 88,
          height: 88,
          borderRadius: 44,
          backgroundColor: isDark ? 'rgba(239, 68, 68, 0.08)' : 'rgba(239, 68, 68, 0.06)',
        }}
      >
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: isDark ? 'rgba(239, 68, 68, 0.15)' : 'rgba(239, 68, 68, 0.10)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name={icon} size={30} color={colors.error.DEFAULT} />
        </View>
      </View>
      <Text variant="h4" className="text-center mb-2" style={forceDark ? { color: '#f5f5f5' } : undefined}>
        {title}
      </Text>
      <Text variant="bodySmall" color="secondary" className="text-center mb-6 px-8 leading-relaxed">
        {description}
      </Text>
      {onRetry && (
        <Button
          title={retryLabel}
          variant="outline"
          size="md"
          forceDark={forceDark}
          onPress={onRetry}
        />
      )}
    </View>
  );
}
