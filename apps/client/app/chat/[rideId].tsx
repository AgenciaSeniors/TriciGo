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
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';
import { useChatStore } from '@/stores/chat.store';
import { useChatInit, useChatActions } from '@/hooks/useChat';
import type { ChatMessage } from '@tricigo/types';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { IconButton } from '@tricigo/ui/IconButton';
import { QuickReplyBar } from '@tricigo/ui/QuickReplyBar';
import { getQuickRepliesForRole } from '@tricigo/utils';

export default function ChatScreen() {
  const { rideId } = useLocalSearchParams<{ rideId: string }>();
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);
  const messages = useChatStore((s) => s.messages);
  const [text, setText] = useState('');
  const flatListRef = useRef<FlatList<ChatMessage>>(null);

  useChatInit(rideId!);
  const { sendMessage } = useChatActions(rideId!);

  const quickReplies = getQuickRepliesForRole('rider').map((qr) => ({
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
            : t('a11y.message_from_other', { ns: 'common', sender: t('chat.chat_driver'), message: item.body })
        }
      >
        <View
          className={`px-4 py-2 rounded-2xl ${
            isOwn ? 'bg-primary-500 rounded-br-sm' : 'bg-neutral-200 rounded-bl-sm'
          }`}
        >
          <Text
            variant="body"
            color={isOwn ? 'inverse' : 'primary'}
          >
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
    <Screen bg="white">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Header */}
        <View className="px-4 py-3 border-b border-neutral-100">
          <ScreenHeader
            title={t('chat.chat_driver')}
            onBack={() => router.back()}
            className="mb-0"
          />
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

        {/* Quick replies */}
        <QuickReplyBar
          replies={quickReplies}
          onPress={(label) => sendMessage(label)}
          variant="light"
        />

        {/* Input bar */}
        <View className="flex-row items-center px-4 py-2 border-t border-neutral-100">
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={t('chat.placeholder')}
            accessibilityLabel={t('chat.placeholder')}
            className="flex-1 bg-neutral-100 rounded-full px-4 py-2 text-base"
            multiline
            maxLength={500}
          />
          <IconButton
            icon="send"
            variant={text.trim() ? 'primary' : 'secondary'}
            size="md"
            onPress={handleSend}
            disabled={!text.trim()}
            className="ml-2"
            label={t('chat.send', { defaultValue: 'Send' })}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
