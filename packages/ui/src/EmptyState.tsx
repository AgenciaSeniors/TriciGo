import React, { type ComponentProps } from 'react';
import { View, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { Button } from './Button';
import { colors } from '@tricigo/theme';

export interface EmptyStateProps {
  icon: ComponentProps<typeof Ionicons>['name'];
  title: string;
  description?: string;
  action?: { label: string; onPress: () => void };
  className?: string;
  /** Compact variant uses less vertical padding */
  compact?: boolean;
  /** Force dark background mode (light text on dark bg) */
  forceDark?: boolean;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact = false,
  forceDark = false,
}: EmptyStateProps) {
  const colorScheme = useColorScheme();
  const isDark = forceDark || colorScheme === 'dark';

  return (
    <View className={`items-center ${compact ? 'py-10' : 'py-16'} ${className ?? ''}`}>
      {/* Double-ring icon container for visual depth */}
      <View
        className="items-center justify-center mb-6"
        style={{
          width: 88,
          height: 88,
          borderRadius: 44,
          backgroundColor: isDark ? 'rgba(255, 77, 0, 0.08)' : 'rgba(255, 77, 0, 0.06)',
        }}
      >
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: isDark ? 'rgba(255, 77, 0, 0.15)' : 'rgba(255, 77, 0, 0.12)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name={icon} size={30} color={colors.primary[500]} />
        </View>
      </View>
      <Text variant="h4" className="text-center mb-2" style={forceDark ? { color: '#f5f5f5' } : undefined}>
        {title}
      </Text>
      {description && (
        <Text variant="bodySmall" color="secondary" className="text-center mb-6 px-10 leading-relaxed">
          {description}
        </Text>
      )}
      {action && (
        <Button
          title={action.label}
          variant="primary"
          size="md"
          onPress={action.onPress}
          className="mt-1"
        />
      )}
    </View>
  );
}
