import React, { type ComponentProps } from 'react';
import { View } from 'react-native';
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
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <View className={`items-center py-16 ${className ?? ''}`}>
      <View className="w-20 h-20 rounded-full bg-neutral-100 items-center justify-center mb-4">
        <Ionicons name={icon} size={36} color={colors.neutral[400]} />
      </View>
      <Text variant="body" color="secondary" className="text-center mb-1">
        {title}
      </Text>
      {description && (
        <Text variant="bodySmall" color="tertiary" className="text-center mb-4 px-8">
          {description}
        </Text>
      )}
      {action && (
        <Button
          title={action.label}
          variant="outline"
          size="sm"
          onPress={action.onPress}
          className="mt-2"
        />
      )}
    </View>
  );
}
