import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Pressable, FlatList, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { supportService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import type { SupportTicket, TicketMessage } from '@tricigo/types';

const STATUS_LABELS: Record<string, string> = {
  open: 'Abierto',
  in_progress: 'En proceso',
  waiting_user: 'Esperando respuesta',
  resolved: 'Resuelto',
  closed: 'Cerrado',
};

export default function DriverTicketDetailScreen() {
  const { t } = useTranslation('common');
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  const userId = useAuthStore((s) => s.user?.id);
  const flatListRef = useRef<FlatList>(null);

  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);

  const fetchData = useCallback(async () => {
    if (!ticketId) return;
    try {
      const [ticketData, messagesData] = await Promise.all([
        supportService.getTicket(ticketId),
        supportService.getMessages(ticketId),
      ]);
      setTicket(ticketData);
      setMessages(messagesData);
    } catch (err) {
      console.warn('[TicketDetail] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSend = async () => {
    if (!userId || !ticketId || !messageText.trim()) return;
    setSending(true);
    try {
      await supportService.sendMessage({
        ticket_id: ticketId,
        sender_id: userId,
        message: messageText.trim(),
      });
      setMessageText('');
      await fetchData();
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    } catch (err) {
      console.warn('[TicketDetail] Failed to send message:', err);
    } finally {
      setSending(false);
    }
  };

  const renderMessage = ({ item }: { item: TicketMessage }) => {
    const isOwn = item.sender_id === userId;
    return (
      <View className={`mb-3 ${isOwn ? 'items-end' : 'items-start'}`}>
        <View
          className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
            isOwn ? 'bg-primary-500' : item.is_admin ? 'bg-blue-100' : 'bg-neutral-100'
          }`}
        >
          {item.is_admin && (
            <Text variant="caption" className="text-blue-600 font-semibold mb-0.5">
              Soporte
            </Text>
          )}
          <Text variant="bodySmall" className="text-neutral-900">
            {item.message}
          </Text>
        </View>
        <Text variant="caption" color="primary" className="mt-0.5 mx-1 opacity-40">
          {new Date(item.created_at).toLocaleTimeString('es-CU', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </Text>
      </View>
    );
  };

  const isClosed = ticket?.status === 'closed' || ticket?.status === 'resolved';

  return (
    <Screen bg="lightPrimary" statusBarStyle="dark-content">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
        keyboardVerticalOffset={0}
      >
        <View className="flex-1">
          {/* Header */}
          <View className="px-5 pt-4 pb-3 border-b border-[#E2E8F0]">
            <View className="flex-row items-center">
              <Pressable onPress={() => router.back()} className="mr-3">
                <Ionicons name="arrow-back" size={24} color={colors.neutral[800]} />
              </Pressable>
              <View className="flex-1">
                <Text variant="body" color="primary" className="font-semibold" numberOfLines={1}>
                  {ticket?.subject ?? 'Ticket'}
                </Text>
                <Text variant="caption" color="primary" className="opacity-50">
                  {STATUS_LABELS[ticket?.status ?? 'open'] ?? ticket?.status}
                </Text>
              </View>
            </View>
          </View>

          {/* Messages */}
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessage}
            contentContainerStyle={{ padding: 20, flexGrow: 1 }}
            onContentSizeChange={() => {
              if (messages.length > 0) {
                flatListRef.current?.scrollToEnd({ animated: false });
              }
            }}
            ListEmptyComponent={
              !loading ? (
                <View className="flex-1 items-center justify-center">
                  <Text variant="bodySmall" color="primary" className="opacity-50">
                    No hay mensajes aún. Escribe el primero.
                  </Text>
                </View>
              ) : null
            }
          />

          {/* Input bar */}
          {!isClosed ? (
            <View className="flex-row items-end px-4 py-3 border-t border-[#E2E8F0] bg-white">
              <TextInput
                className="flex-1 border border-[#E2E8F0] rounded-2xl px-4 py-2.5 mr-2 text-neutral-900 max-h-24"
                placeholder="Escribe un mensaje..."
                placeholderTextColor="#737373"
                value={messageText}
                onChangeText={setMessageText}
                multiline
              />
              <Pressable
                onPress={handleSend}
                disabled={!messageText.trim() || sending}
                className={`w-10 h-10 rounded-full items-center justify-center ${
                  messageText.trim() ? 'bg-primary-500' : 'bg-neutral-200'
                }`}
              >
                <Ionicons
                  name="send"
                  size={18}
                  color={messageText.trim() ? '#FFFFFF' : '#737373'}
                />
              </Pressable>
            </View>
          ) : (
            <View className="px-4 py-3 border-t border-[#E2E8F0] bg-white">
              <Text variant="bodySmall" color="primary" className="text-center opacity-50">
                Este ticket está {ticket?.status === 'resolved' ? 'resuelto' : 'cerrado'}
              </Text>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
