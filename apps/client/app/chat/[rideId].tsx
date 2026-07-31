import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  FlatList,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  ActionSheetIOS,
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
import Toast from 'react-native-toast-message';
import { blockService, incidentService, chatService } from '@tricigo/api';

export default function ChatScreen() {
  const { rideId } = useLocalSearchParams<{ rideId: string }>();
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);
  const messages = useChatStore((s) => s.messages);
  // Realtime presence: does the driver have THIS chat open right now?
  const driverInChat = useChatStore((s) => s.remotePresent);
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

  // Opening the chat IS reading it: stamp read_at server-side (00516). That
  // both clears this rider's unread badge and turns the driver's bubbles
  // double-checked. Re-runs as messages arrive so a conversation read live
  // does not leave the last line unread.
  //
  // Replaces the old AsyncStorage "last read" timestamp, which was local to
  // one device and invisible to the other party.
  useEffect(() => {
    if (!rideId) return;
    chatService.markRead(rideId).catch(() => { /* best-effort */ });
  }, [rideId, messages.length]);

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
            isOwn ? 'bg-primary-500 rounded-br-sm' : 'bg-neutral-200 dark:bg-neutral-800 rounded-bl-sm'
          }`}
        >
          <Text
            variant="body"
            color={isOwn ? 'inverse' : 'primary'}
          >
            {item.body}
          </Text>
        </View>
        <View className={`flex-row items-center mt-1 ${isOwn ? 'self-end' : 'self-start'}`}>
          <Text variant="caption" color="secondary">
            {new Date(item.created_at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'America/Havana',
            })}
          </Text>
          {/* Delivery/read state, own messages only — the rider has no use for
              a check mark on a line the driver wrote. Single = sent, double =
              the driver opened the chat (read_at, 00516). Parity with the
              driver's ChatBubble. */}
          {isOwn && (
            <Ionicons
              name={item.read_at ? 'checkmark-done' : 'checkmark'}
              size={13}
              color={item.read_at ? colors.primary[500] : colors.neutral[400]}
              style={{ marginLeft: 4 }}
              accessibilityLabel={
                item.read_at
                  ? t('chat.message_read', { defaultValue: 'Leído' })
                  : t('chat.message_sent', { defaultValue: 'Enviado' })
              }
            />
          )}
        </View>
      </View>
    );
  };

  // ── Safety: block / report the driver from the chat (Apple Guideline 1.2) ──
  // The chat is user-generated content, so block + report must be reachable in
  // context (not only post-ride). Reuses existing, already-deployed services.
  const driverUserId = rideWithDriver?.driver_user_id ?? null;

  const confirmBlock = (targetId: string) => {
    Alert.alert(
      t('chat.block_confirm_title', { defaultValue: '¿Bloquear conductor?' }),
      t('chat.block_confirm_msg', { defaultValue: 'No volverás a emparejarte con este conductor y no podrán chatear.' }),
      [
        { text: t('chat.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
        {
          text: t('chat.block_action', { defaultValue: 'Bloquear' }),
          style: 'destructive',
          onPress: async () => {
            try {
              await blockService.blockUser(targetId);
              triggerHaptic('success');
              Toast.show({ type: 'success', text1: t('chat.blocked_ok', { defaultValue: 'Conductor bloqueado' }) });
              router.back();
            } catch {
              Toast.show({ type: 'error', text1: t('chat.action_failed', { defaultValue: 'No se pudo completar. Prueba de nuevo.' }) });
            }
          },
        },
      ],
    );
  };

  const confirmReport = (targetId: string) => {
    Alert.alert(
      t('chat.report_confirm_title', { defaultValue: '¿Reportar conductor?' }),
      t('chat.report_confirm_msg', { defaultValue: 'Enviaremos este viaje a nuestro equipo de seguridad para que lo revise.' }),
      [
        { text: t('chat.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
        {
          text: t('chat.report_action', { defaultValue: 'Reportar' }),
          onPress: async () => {
            try {
              if (user?.id && rideId) {
                await incidentService.createSafetyReport({
                  ride_id: rideId,
                  reported_by: user.id,
                  against_user_id: targetId,
                  type: 'driver_behavior',
                  description: 'Reportado por el pasajero desde el chat del viaje.',
                });
              }
              triggerHaptic('success');
              Toast.show({ type: 'success', text1: t('chat.report_ok', { defaultValue: 'Reporte enviado' }) });
            } catch {
              Toast.show({ type: 'error', text1: t('chat.action_failed', { defaultValue: 'No se pudo completar. Prueba de nuevo.' }) });
            }
          },
        },
      ],
    );
  };

  const openSafetyMenu = () => {
    if (!driverUserId) return;
    const blockLabel = t('chat.block_user', { defaultValue: 'Bloquear conductor' });
    const reportLabel = t('chat.report_user', { defaultValue: 'Reportar conductor' });
    const cancelLabel = t('chat.cancel', { defaultValue: 'Cancelar' });
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [cancelLabel, blockLabel, reportLabel], cancelButtonIndex: 0, destructiveButtonIndex: 1 },
        (i) => {
          if (i === 1) confirmBlock(driverUserId);
          else if (i === 2) confirmReport(driverUserId);
        },
      );
    } else {
      Alert.alert(t('chat.safety_menu_title', { defaultValue: 'Seguridad' }), undefined, [
        { text: blockLabel, style: 'destructive', onPress: () => confirmBlock(driverUserId) },
        { text: reportLabel, onPress: () => confirmReport(driverUserId) },
        { text: cancelLabel, style: 'cancel' },
      ]);
    }
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
            rightAction={
              driverUserId ? (
                <Pressable
                  onPress={openSafetyMenu}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('chat.safety_menu_title', { defaultValue: 'Seguridad' })}
                  className="w-10 h-10 rounded-full items-center justify-center bg-neutral-100 dark:bg-neutral-800 active:bg-neutral-200 dark:active:bg-neutral-700"
                >
                  <Ionicons name="ellipsis-vertical" size={20} color={colors.neutral[500]} />
                </Pressable>
              ) : undefined
            }
          />
        </View>

        {/* Presence — shown only while the driver actually has this chat open.
             Says what Realtime presence can prove and nothing more; absent, it
             renders nothing rather than guessing. */}
        {driverInChat && (
          <View className="px-4 py-1 bg-green-50 dark:bg-green-900/20">
            <Text variant="caption" className="text-center text-green-700 dark:text-green-400">
              {t('chat.in_chat', { defaultValue: 'El conductor está en el chat' })}
            </Text>
          </View>
        )}

        {/* Offline banner. The previous copy told the rider to retry manually,
             on the belief that nothing was buffered — but BUG-243 added an
             auto-draining queue to this very screen's hook, and its own toast
             already promises "se enviará cuando vuelva la conexión". The banner
             and the toast contradicted each other two lines apart. The queue is
             real, so the banner now says so. */}
        {isOffline && (
          <View className="bg-red-500 px-4 py-2">
            <Text variant="caption" color="inverse" className="text-center">
              {t('chat.offline_banner', { defaultValue: 'Sin conexión. Tus mensajes se enviarán solos al reconectar.' })}
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
                {t('chat.no_messages_title', { defaultValue: 'Empieza la conversación' })}
              </Text>
              <Text variant="caption" color="tertiary" className="text-center">
                {t('chat.no_messages_hint', { defaultValue: 'Toca una respuesta rápida o escribe abajo' })}
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
              className="flex-1 bg-neutral-100 dark:bg-neutral-800 rounded-full px-4 py-2 text-base text-neutral-900 dark:text-neutral-100"
              placeholderTextColor={colors.neutral[400]}
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
