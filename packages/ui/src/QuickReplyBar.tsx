import React from 'react';
import { ScrollView, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';

export interface QuickReplyItem {
  key: string;
  icon: string;
  label: string;
}

interface QuickReplyBarProps {
  replies: QuickReplyItem[];
  onPress: (label: string) => void;
  /** Theme variant — matches the chat screen background */
  variant?: 'light' | 'dark';
}

export function QuickReplyBar({ replies, onPress, variant = 'light' }: QuickReplyBarProps) {
  if (replies.length === 0) return null;

  const pillBg = variant === 'dark' ? 'bg-neutral-800' : 'bg-neutral-100';
  const iconColor = variant === 'dark' ? '#f97316' : '#f97316'; // brand orange

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 6 }}
    >
      <View className="flex-row gap-2">
        {replies.map((reply) => (
          <Pressable
            key={reply.key}
            className={`flex-row items-center ${pillBg} rounded-full px-3 py-1.5`}
            onPress={() => onPress(reply.label)}
            accessibilityRole="button"
            accessibilityLabel={reply.label}
          >
            <Ionicons
              name={reply.icon as any}
              size={14}
              color={iconColor}
            />
            <Text
              variant="caption"
              color={variant === 'dark' ? 'inverse' : 'primary'}
              className="ml-1.5"
            >
              {reply.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
