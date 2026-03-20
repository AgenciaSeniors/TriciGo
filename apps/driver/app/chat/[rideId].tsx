import React, { useState, useRef } from 'react';
import {
  View,
  FlatList,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';
import { useChatStore } from '@/stores/chat.store';
import { useChatInit, useChatActions } from '@/hooks/useChat';
import type { ChatMessage } from '@tricigo/types';
import { QuickReplyBar } from '@tricigo/ui/QuickReplyBar';
import { getQuickRepliesForRole } from '@tricigo/utils';

export default function ChatScreen() {
  const { rideId } = useLocalSearchParams<{ rideId: string }>();
  const { t } = useTranslation('driver');
  const user = useAuthStore((s) => s.user);
  const messages = useChatStore((s) => s.messages);
  const [text, setText] = useState('');
  const flatListRef = useRef<FlatList<ChatMessage>>(null);

  const remoteTyping = useChatStore((s) => s.remoteTyping);

  useChatInit(rideId!);
  const { sendMessage, notifyTyping } = useChatActions(rideId!);

  const quickReplies = getQuickRepliesForRole('driver').map((qr) => ({
    key: qr.key,
    icon: qr.icon,
    label: t(`chat.quick_${qr.key}` as any, { defaultValue: qr.key }),
  }));

  const handleSend = async () => {
    if (!text.trim()) return;
    const msg = text;
    setText('');
    await sendMessage(msg);
  };

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const isOwn = item.sender_id === user?.id;
    return (
      <View
        className={`mb-2 max-w-[80%] ${isOwn ? 'self-end' : 'self-start'}`}
        accessible={true}
        accessibilityLabel={
          isOwn
            ? t('a11y.message_from_you', { ns: 'common', message: item.body })
            : t('a11y.message_from_other', { ns: 'common', sender: t('trip.chat_passenger', { defaultValue: 'Pasajero' }), message: item.body })
        }
      >
        <View
          className={`px-4 py-2 rounded-2xl ${
            isOwn ? 'bg-primary-500 rounded-br-sm' : 'bg-neutral-700 rounded-bl-sm'
          }`}
        >
          <Text variant="body" color="inverse">
            {item.body}
          </Text>
        </View>
        <Text
          variant="caption"
          color="secondary"
          className={`mt-1 ${isOwn ? 'text-right' : 'text-left'}`}
        >
          {new Date(item.created_at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </Text>
      </View>
    );
  };

  return (
    <Screen bg="dark">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Header */}
        <View className="flex-row items-center px-4 py-3 border-b border-neutral-800">
          <Pressable onPress={() => router.back()} className="mr-3" accessibilityRole="button" accessibilityLabel={t('common:back')}>
            <Ionicons name="arrow-back" size={22} color={colors.primary[500]} />
          </Pressable>
          <Text variant="h4" color="inverse" className="flex-1">
            {t('trip.chat_passenger', { defaultValue: 'Chat con pasajero' })}
          </Text>
        </View>

        {/* Messages */}
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          accessibilityLiveRegion="polite"
          contentContainerStyle={{ padding: 16, flexGrow: 1, justifyContent: 'flex-end' }}
          ListEmptyComponent={
            <View className="flex-1 items-center justify-center">
              <Text variant="body" color="secondary">
                {t('chat.no_messages')}
              </Text>
            </View>
          }
          onContentSizeChange={() =>
            flatListRef.current?.scrollToEnd({ animated: true })
          }
        />

        {/* Typing indicator */}
        {remoteTyping && (
          <View className="px-4 py-1">
            <Text variant="caption" color="secondary">
              {t('chat.typing', { defaultValue: 'El pasajero está escribiendo...' })}
            </Text>
          </View>
        )}

        {/* Quick replies */}
        <QuickReplyBar
          replies={quickReplies}
          onPress={(label) => sendMessage(label)}
          variant="dark"
        />

        {/* Input bar */}
        <View className="flex-row items-center px-4 py-2 border-t border-neutral-800">
          <TextInput
            value={text}
            onChangeText={(v) => { setText(v); notifyTyping(); }}
            placeholder={t('chat.placeholder')}
            accessibilityLabel={t('chat.placeholder')}
            placeholderTextColor={colors.neutral[500]}
            className="flex-1 bg-neutral-800 rounded-full px-4 py-2 text-base text-white"
            multiline
            maxLength={500}
          />
          <Pressable
            onPress={handleSend}
            disabled={!text.trim()}
            accessibilityRole="button"
            accessibilityLabel={t('chat.send', { defaultValue: 'Send' })}
            accessibilityState={{ disabled: !text.trim() }}
            className="ml-2 bg-primary-500 w-10 h-10 rounded-full items-center justify-center"
          >
            <Ionicons name="send" size={18} color="white" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
