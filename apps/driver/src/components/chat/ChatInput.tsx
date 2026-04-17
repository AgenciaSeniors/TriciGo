import React, { useState, useRef } from 'react';
import { View, TextInput, Pressable, Animated, StyleSheet, ScrollView, Platform, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface QuickReply {
  id: string;
  text: string;
}

interface ChatInputProps {
  onSend: (message: string) => void;
  onQuickReply?: (text: string) => void;
  quickReplies?: QuickReply[];
  placeholder?: string;
  theme?: 'light' | 'dark';
}

export function ChatInput({ onSend, onQuickReply, quickReplies = [], placeholder = 'Mensaje...', theme = 'dark' }: ChatInputProps) {
  const [text, setText] = useState('');
  const sendScaleAnim = useRef(new Animated.Value(1)).current;
  const isDark = theme === 'dark';

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Spring animation on send
    Animated.sequence([
      Animated.spring(sendScaleAnim, { toValue: 0.85, useNativeDriver: true, tension: 300, friction: 10 }),
      Animated.spring(sendScaleAnim, { toValue: 1, useNativeDriver: true, tension: 300, friction: 10 }),
    ]).start();

    onSend(trimmed);
    setText('');
  };

  const handleQuickReply = (reply: QuickReply) => {
    if (onQuickReply) {
      onQuickReply(reply.text);
    } else {
      onSend(reply.text);
    }
  };

  return (
    <View style={[styles.container, isDark ? styles.containerDark : styles.containerLight]}>
      {/* Quick reply pills */}
      {quickReplies.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.quickRepliesContainer}
          style={styles.quickRepliesScroll}
        >
          {quickReplies.map((reply) => (
            <Pressable
              key={reply.id}
              onPress={() => handleQuickReply(reply)}
              style={({ pressed }) => [
                styles.quickReplyPill,
                isDark ? styles.quickReplyPillDark : styles.quickReplyPillLight,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={[styles.quickReplyText, isDark ? styles.quickReplyTextDark : styles.quickReplyTextLight]}>
                {reply.text}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* Input row */}
      <View style={styles.inputRow}>
        {/* Mic icon placeholder */}
        <Pressable style={styles.micBtn} accessibilityLabel="Audio message">
          <Ionicons name="mic-outline" size={22} color={isDark ? '#6B7280' : '#9CA3AF'} />
        </Pressable>

        <TextInput
          style={[
            styles.textInput,
            isDark ? styles.textInputDark : styles.textInputLight,
          ]}
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={isDark ? '#6B7280' : '#9CA3AF'}
          multiline
          maxLength={500}
          onSubmitEditing={handleSend}
          returnKeyType="send"
          blurOnSubmit={false}
        />

        {/* Send button */}
        <Animated.View style={{ transform: [{ scale: sendScaleAnim }] }}>
          <Pressable
            onPress={handleSend}
            disabled={!text.trim()}
            style={[
              styles.sendBtn,
              text.trim() ? styles.sendBtnActive : styles.sendBtnInactive,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Enviar mensaje"
          >
            <Ionicons name="send" size={18} color={text.trim() ? '#fff' : '#6B7280'} />
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    paddingBottom: Platform.OS === 'ios' ? 20 : 8,
  },
  containerDark: {
    backgroundColor: '#141418',
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  containerLight: {
    backgroundColor: '#FFFFFF',
    borderTopColor: '#E2E8F0',
  },
  quickRepliesScroll: {
    maxHeight: 44,
  },
  quickRepliesContainer: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    flexDirection: 'row',
  },
  quickReplyPill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  quickReplyPillDark: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: 'rgba(255,255,255,0.1)',
  },
  quickReplyPillLight: {
    backgroundColor: '#F8FAFC',
    borderColor: '#E2E8F0',
  },
  quickReplyText: {
    fontSize: 13,
    fontFamily: 'Inter',
    fontWeight: '500',
  },
  quickReplyTextDark: {
    color: '#D1D5DB',
  },
  quickReplyTextLight: {
    color: '#374151',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingTop: 4,
    gap: 6,
  },
  micBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 15,
    fontFamily: 'Inter',
    borderWidth: 1,
  },
  textInputDark: {
    backgroundColor: '#1c1c24',
    borderColor: 'rgba(255,255,255,0.08)',
    color: '#F1F1F3',
  },
  textInputLight: {
    backgroundColor: '#F1F5F9',
    borderColor: '#E2E8F0',
    color: '#0F172A',
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnActive: {
    backgroundColor: '#FF4D00',
  },
  sendBtnInactive: {
    backgroundColor: 'transparent',
  },
});
