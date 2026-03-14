import React from 'react';
import { View, Image, Pressable } from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import { Text } from './Text';
import { Card } from './Card';
import { Ionicons } from '@expo/vector-icons';

export interface ServiceTypeCardProps {
  /** Service type slug identifier */
  slug: string;
  /** Localized display name */
  name: string;
  /** Vehicle icon image source (from require()) */
  icon: ImageSourcePropType;
  /** Whether this service type is currently selected */
  selected?: boolean;
  /** Press handler for selection */
  onPress?: () => void;
  /** Optional price hint text (e.g. "~150 CUP") */
  priceHint?: string;
  /** Max passengers for this service type */
  maxPassengers?: number;
  /** Compact mode for horizontal scroll (smaller icon) */
  compact?: boolean;
}

export function ServiceTypeCard({
  slug,
  name,
  icon,
  selected = false,
  onPress,
  priceHint,
  maxPassengers,
  compact = false,
}: ServiceTypeCardProps) {
  const iconSize = compact ? 48 : 64;

  return (
    <Pressable
      onPress={onPress}
      className="flex-1"
      accessibilityRole="radio"
      accessibilityLabel={`${name}${priceHint ? `, ${priceHint}` : ''}${maxPassengers != null ? `, ${maxPassengers} passengers` : ''}`}
      accessibilityState={{ selected }}
    >
      <Card
        variant="outlined"
        padding="md"
        className={`items-center ${
          selected
            ? 'border-primary-500 bg-primary-50'
            : 'border-neutral-200 bg-white'
        }`}
      >
        <Image
          source={icon}
          style={{ width: iconSize, height: iconSize, marginBottom: 4 }}
          resizeMode="contain"
          accessibilityElementsHidden
        />
        <Text
          variant={compact ? 'caption' : 'bodySmall'}
          color={selected ? 'accent' : 'secondary'}
          className="text-center font-medium"
        >
          {name}
        </Text>

        {priceHint && (
          <Text variant="caption" color="secondary" className="text-center mt-0.5 opacity-70">
            {priceHint}
          </Text>
        )}

        {maxPassengers != null && !compact && (
          <View className="flex-row items-center mt-1 gap-0.5">
            <Ionicons name="person-outline" size={10} color="#9ca3af" />
            <Text variant="caption" color="secondary" className="opacity-60">
              {maxPassengers}
            </Text>
          </View>
        )}
      </Card>
    </Pressable>
  );
}
