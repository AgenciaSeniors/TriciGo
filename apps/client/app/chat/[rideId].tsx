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
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { ErrorState } from '@tricigo/ui/ErrorState';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';
import { useChatStore } from '@/stores/chat.store';
import { useRideStore } from '@/stores/ride.store';
import { useChatInit, useChatActions } from '@/hooks/useChat';
import type { ChatMessage } from '@tricigo/types';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { IconButton } from '@tricigo/ui/IconButton';
import { QuickReplyBar } from '@tricigo/ui/QuickReplyBar';
import { getQuickRepliesForRole, triggerHaptic } from '@tricigo/utils';
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
  const rideWithDriver = useRideStore((s) => s.rideWithDriver);

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
    // UX: a light haptic confirms the message left the keyboard — the
    // send button loses focus + the text field clears anyway, but the
    // tactile tap closes the action loop on the rider's finger.
    triggerHaptic('light');
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
    <Screen bg="cuban">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Header — UX: a generic "Chat del conductor" gave no context for
             who the rider is actually talking to. If we have the driver's
             name + plate (we always do during an active ride) show them
             so the rider has instant certainty they're messaging the
             right person. Falls back to the generic label pre-match. */}
        <View className="px-4 py-3 border-b border-neutral-100">
          <ScreenHeader
            // `string.split()[0]` is typed `string | undefined` under
            // noUncheckedIndexedAccess. It's unreachable in practice
            // (a non-empty source string always yields at least one
            // segment) but we still have to satisfy the prop type.
            title={(rideWithDriver?.driver_name?.split(' ')[0]) || t('chat.chat_driver')}
            subtitle={
              rideWithDriver?.vehicle_plate || rideWithDriver?.vehicle_make
                ? [
                    rideWithDriver.vehicle_make,
                    rideWithDriver.vehicle_model,
                    rideWithDriver.vehicle_plate ? `· ${rideWithDriver.vehicle_plate}` : null,
                  ].filter(Boolean).join(' ')
                : undefined
            }
            onBack={() => router.back()}
            className="mb-0"
          />
        </View>

        {/* Offline banner — UX: the old copy promised auto-delivery on
             reconnect ("se enviarán cuando vuelvas a estar en línea") but
             the chat service doesn't actually queue offline sends — it
             fails immediately with a _failed flag on the optimistic
             message. Be honest: tell the rider the connection is gone
             and to retry manually, so they don't assume a typed message
             is safely buffered. */}
        {isOffline && (
          <View className="bg-red-500 px-4 py-2">
            <Text variant="caption" color="inverse" className="text-center">
              {t('chat.offline_banner', { defaultValue: 'Sin conexión. Intentá enviar de nuevo cuando se restablezca.' })}
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
            /* BUG-240: redesigned empty state. Was flat text floating in a
               huge gap. Now: centered icon + compact text + visual hint
               toward the quick-reply bar below. Reads warmer and gives
               clear affordance ("tap a chip to start"). */
            <View className="flex-1 items-center justify-center px-8">
              <View style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: 'rgba(255,77,0,0.10)',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
              }}>
                <Ionicons name="chatbubble-ellipses-outline" size={28} color="#FF4D00" />
              </View>
              <Text variant="h4" color="primary" className="text-center mb-1">
                {t('chat.no_messages_title', { defaultValue: 'Empezá la conversación' })}
              </Text>
              <Text variant="caption" color="tertiary" className="text-center">
                {t('chat.no_messages_hint', { defaultValue: 'Tocá una respuesta rápida o escribí abajo' })}
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
        <View className="px-4 py-2 border-t border-neutral-100">
          <View className="flex-row items-center">
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
          {/* UX: no counter by default avoids noise, but drivers writing
               a longer explanation hit the cap silently and wondered why
               typing stopped registering. Surface the counter only in
               the last ~20% of the limit so short messages stay clean. */}
          {text.length >= 400 && (
            <Text
              variant="caption"
              color={text.length >= 490 ? 'error' : 'tertiary'}
              className="text-right mt-1 mr-2"
            >
              {text.length}/500
            </Text>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
