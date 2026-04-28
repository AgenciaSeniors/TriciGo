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

  // BUG-240: explicit height and alignSelf to prevent parent flex
  // containers from vertically stretching the pills (was producing
  // ~500pt-tall capsule shapes in the chat empty state).
  return (
    <View style={{ height: 44, justifyContent: 'center' }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 12, alignItems: 'center', gap: 8 }}
      >
        {replies.map((reply) => (
          <Pressable
            key={reply.key}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              alignSelf: 'flex-start',
              height: 32,
              paddingHorizontal: 12,
              borderRadius: 16,
              backgroundColor: variant === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
              borderWidth: 1,
              borderColor: variant === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
            }}
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
      </ScrollView>
    </View>
  );
}
