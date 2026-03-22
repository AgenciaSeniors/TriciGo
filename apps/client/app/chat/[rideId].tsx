import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  FlatList,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { ErrorState } from '@tricigo/ui/ErrorState';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';
import { useChatStore } from '@/stores/chat.store';
import { useChatInit, useChatActions } from '@/hooks/useChat';
import type { ChatMessage } from '@tricigo/types';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { IconButton } from '@tricigo/ui/IconButton';
import { QuickReplyBar } from '@tricigo/ui/QuickReplyBar';
import { getQuickRepliesForRole } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import NetInfo from '@react-native-community/netinfo';

export default function ChatScreen() {
  const { rideId } = useLocalSearchParams<{ rideId: string }>();
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);
  const messages = useChatStore((s) => s.messages);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const flatListRef = useRef<FlatList<ChatMessage>>(null);

  const remoteTyping = useChatStore((s) => s.remoteTyping);

  useChatInit(rideId!);
  const { sendMessage, notifyTyping } = useChatActions(rideId!);

  // Track loading state — messages arrive via store
  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 1500);
    return () => clearTimeout(timer);
  }, []);

  // Clear loading once messages arrive
  useEffect(() => {
    if (messages.length > 0) setLoading(false);
  }, [messages]);

  // Network connectivity monitor
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsOffline(!(state.isConnected ?? true));
    });
    return () => unsubscribe();
  }, []);

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

        {/* Offline banner */}
        {isOffline && (
          <View className="bg-red-500 px-4 py-2">
            <Text variant="caption" color="inverse" className="text-center">
              {t('chat.offline_banner', { defaultValue: 'Sin conexión. Los mensajes se enviarán cuando vuelvas a estar en línea.' })}
            </Text>
          </View>
        )}

        {/* Messages */}
        {loading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color={colors.brand.orange} />
          </View>
        ) : error ? (
          <ErrorState
            title={t('chat.error_title', { defaultValue: 'Error al cargar mensajes' })}
            description={error}
            onRetry={() => {
              setError(null);
              setLoading(true);
              setTimeout(() => setLoading(false), 1500);
            }}
            retryLabel={t('common.retry', { defaultValue: 'Reintentar' })}
          />
        ) : (
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
        )}

        {/* Typing indicator */}
        {remoteTyping && (
          <View className="px-4 py-1">
            <Text variant="caption" color="secondary">
              {t('chat.typing', { defaultValue: 'El conductor está escribiendo...' })}
            </Text>
          </View>
        )}

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
            onChangeText={(v) => { setText(v); notifyTyping(); }}
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
