import React, { useRef, useMemo } from 'react';
import {
  View,
  FlatList,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';
import { useChatStore } from '@/stores/chat.store';
import { useChatInit, useChatActions } from '@/hooks/useChat';
import type { ChatMessage } from '@tricigo/types';
import { ChatBubble } from '@/components/chat/ChatBubble';
import { ChatInput } from '@/components/chat/ChatInput';
import { TypingIndicator } from '@/components/chat/TypingIndicator';

/** Group messages by calendar date for date separator rendering. */
function getDateLabel(dateStr: string): { key: string; isToday: boolean; isYesterday: boolean; dateString: string } {
  const date = new Date(dateStr);
  const now = new Date();

  const stripTime = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayMs = 86_400_000;

  const today = stripTime(now);
  const target = stripTime(date);

  const isToday = target === today;
  const isYesterday = target === today - dayMs;
  const dateString = date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

  return { key: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`, isToday, isYesterday, dateString };
}

export default function ChatScreen() {
  const { rideId } = useLocalSearchParams<{ rideId: string }>();
  const { t } = useTranslation('driver');
  const user = useAuthStore((s) => s.user);
  const messages = useChatStore((s) => s.messages);
  const remoteTyping = useChatStore((s) => s.remoteTyping);
  const flatListRef = useRef<FlatList<any>>(null);

  useChatInit(rideId!);
  const { sendMessage, notifyTyping } = useChatActions(rideId!);

  const userId = user?.id;

  /** Build a flat list of items that includes date separators interleaved with messages. */
  type ListItem =
    | { type: 'date'; key: string; isToday: boolean; isYesterday: boolean; dateString: string }
    | { type: 'message'; data: ChatMessage };

  const listItems: ListItem[] = useMemo(() => {
    const items: ListItem[] = [];
    let lastDateKey = '';

    for (const msg of messages) {
      const label = getDateLabel(msg.created_at);
      if (label.key !== lastDateKey) {
        items.push({ type: 'date', ...label });
        lastDateKey = label.key;
      }
      items.push({ type: 'message', data: msg });
    }

    return items;
  }, [messages]);

  const handleSend = async (text: string) => {
    if (!text.trim()) return;
    await sendMessage(text);
  };

  const renderItem = ({ item }: { item: ListItem }) => {
    if (item.type === 'date') {
      return (
        <View style={{ alignItems: 'center', marginVertical: 12 }}>
          <Text
            style={{
              fontSize: 12,
              color: '#9CA3AF',
              fontFamily: 'Inter',
              backgroundColor: '#F1F5F9',
              paddingHorizontal: 12,
              paddingVertical: 4,
              borderRadius: 12,
              overflow: 'hidden',
            }}
          >
            {item.isToday ? 'Hoy' : item.isYesterday ? 'Ayer' : item.dateString}
          </Text>
        </View>
      );
    }

    const msg = item.data;
    return (
      <ChatBubble
        message={msg.body}
        timestamp={new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        isOwn={msg.sender_id === userId}
        isRead={false}
        theme="light"
      />
    );
  };

  const riderName: string | undefined = undefined; // rider name not available in chat store

  return (
    <Screen bg="lightPrimary">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Chat Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#E2E8F0', backgroundColor: '#FFFFFF' }}>
          <Pressable onPress={() => router.back()} style={{ marginRight: 12, minWidth: 44, minHeight: 44, justifyContent: 'center' }}>
            <Ionicons name="chevron-back" size={24} color="#0F172A" />
          </Pressable>
          {/* Avatar */}
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#F1F5F9', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
            <Ionicons name="person" size={20} color="#94A3B8" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 16, fontWeight: '600', color: '#0F172A', fontFamily: 'Inter' }}>
              {riderName || t('chat.rider', { defaultValue: 'Pasajero' })}
            </Text>
            <Text style={{ fontSize: 12, color: '#10B981', fontFamily: 'Inter' }}>
              {t('chat.online', { defaultValue: 'En línea' })}
            </Text>
          </View>
          <Pressable style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="call-outline" size={22} color="#0F172A" />
          </Pressable>
        </View>

        {/* Messages */}
        <FlatList
          ref={flatListRef}
          data={listItems}
          keyExtractor={(item: any, index: number) => (item.type === 'date' ? `date-${item.key}` : item.data.id)}
          renderItem={renderItem}
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
        {remoteTyping && <TypingIndicator theme="light" />}

        {/* Input bar */}
        <ChatInput
          onSend={handleSend}
          quickReplies={[
            { id: '1', text: t('chat.quick_on_my_way', { defaultValue: 'Estoy en camino' }) },
            { id: '2', text: t('chat.quick_arriving', { defaultValue: 'Estoy llegando' }) },
            { id: '3', text: t('chat.quick_waiting', { defaultValue: 'Estoy esperando' }) },
            { id: '4', text: t('chat.quick_thanks', { defaultValue: '¡Gracias!' }) },
          ]}
          theme="light"
          placeholder={t('chat.input_placeholder', { defaultValue: 'Escribe un mensaje...' })}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}
