import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface ChatBubbleProps {
  message: string;
  timestamp: string;
  isOwn: boolean;
  isRead?: boolean;
  senderName?: string;
  theme?: 'light' | 'dark';
}

export function ChatBubble({ message, timestamp, isOwn, isRead, senderName, theme = 'dark' }: ChatBubbleProps) {
  const isDark = theme === 'dark';

  return (
    <View style={[styles.container, isOwn ? styles.ownContainer : styles.otherContainer]}>
      {!isOwn && senderName && (
        <Text style={[styles.senderName, { color: isDark ? '#FF8A5C' : '#FF4D00' }]}>{senderName}</Text>
      )}
      <View style={[
        styles.bubble,
        isOwn ? styles.ownBubble : (isDark ? styles.otherBubbleDark : styles.otherBubbleLight),
      ]}>
        <Text style={[styles.messageText, isOwn ? styles.ownText : (isDark ? styles.otherTextDark : styles.otherTextLight)]}>
          {message}
        </Text>
        <View style={styles.metaRow}>
          <Text style={[styles.timestamp, isOwn ? styles.ownTimestamp : (isDark ? styles.otherTimestampDark : styles.otherTimestampLight)]}>
            {timestamp}
          </Text>
          {isOwn && (
            <Ionicons
              name={isRead ? 'checkmark-done' : 'checkmark'}
              size={14}
              color={isRead ? '#60A5FA' : 'rgba(255,255,255,0.4)'}
              style={{ marginLeft: 4 }}
            />
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    marginVertical: 2,
  },
  ownContainer: {
    alignItems: 'flex-end',
  },
  otherContainer: {
    alignItems: 'flex-start',
  },
  senderName: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter',
    marginBottom: 2,
    marginLeft: 12,
  },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  ownBubble: {
    backgroundColor: '#FF4D00',
    borderBottomRightRadius: 4,
  },
  otherBubbleDark: {
    backgroundColor: '#1c1c24',
    borderBottomLeftRadius: 4,
  },
  otherBubbleLight: {
    backgroundColor: '#E5E7EB',
    borderBottomLeftRadius: 4,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 20,
    fontFamily: 'Inter',
  },
  ownText: {
    color: '#FFFFFF',
  },
  otherTextDark: {
    color: '#F1F1F3',
  },
  otherTextLight: {
    color: '#0F172A',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  timestamp: {
    fontSize: 11,
    fontFamily: 'Inter',
  },
  ownTimestamp: {
    color: 'rgba(255,255,255,0.6)',
  },
  otherTimestampDark: {
    color: 'rgba(255,255,255,0.35)',
  },
  otherTimestampLight: {
    color: '#9CA3AF',
  },
});
