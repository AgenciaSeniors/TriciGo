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
      <View className="w-20 h-20 rounded-full bg-[#252540] items-center justify-center mb-5">
        <Ionicons name={icon} size={36} color={colors.brand.orange} />
      </View>
      <Text variant="h4" color="inverse" className="text-center mb-2">
        {title}
      </Text>
      {description && (
        <Text variant="bodySmall" color="secondary" className="text-center mb-6 px-8">
          {description}
        </Text>
      )}
      {action && (
        <Button
          title={action.label}
          variant="primary"
          size="md"
          onPress={action.onPress}
          className="mt-2"
        />
      )}
    </View>
  );
}
