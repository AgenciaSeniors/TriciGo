import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, FlatList, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { IconButton } from '@tricigo/ui/IconButton';
import { Input } from '@tricigo/ui/Input';
import { colors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { supportService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import type { SupportTicket, TicketMessage } from '@tricigo/types';

export default function TicketDetailScreen() {
  const { t } = useTranslation('common');
  const STATUS_LABELS: Record<string, string> = {
    open: t('profile.help_status_open'),
    in_progress: t('profile.help_status_in_progress'),
    waiting_user: t('profile.help_status_waiting_response'),
    resolved: t('profile.help_status_resolved'),
    closed: t('profile.help_status_closed'),
  };
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
            <Text variant="caption" className="text-info-dark font-semibold mb-0.5">
              {t('profile.support_label')}
            </Text>
          )}
          <Text
            variant="bodySmall"
            className={isOwn ? 'text-white' : 'text-neutral-900'}
          >
            {item.message}
          </Text>
        </View>
        <Text variant="caption" color="tertiary" className="mt-0.5 mx-1">
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
    <Screen bg="white">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
        keyboardVerticalOffset={0}
      >
        <View className="flex-1">
          {/* Header */}
          <View className="px-5 pt-4 pb-3 border-b border-neutral-100">
            <ScreenHeader
              title={ticket?.subject ?? 'Ticket'}
              onBack={() => router.back()}
              className="mb-0"
            />
            <Text variant="caption" color="tertiary" className="ml-13">
              {STATUS_LABELS[ticket?.status ?? 'open'] ?? ticket?.status}
            </Text>
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
                  <Text variant="bodySmall" color="tertiary">
                    {t('profile.ticket_no_messages')}
                  </Text>
                </View>
              ) : null
            }
          />

          {/* Input bar */}
          {!isClosed ? (
            <View className="flex-row items-end px-4 py-3 border-t border-neutral-100 bg-white">
              <View className="flex-1 mr-2">
                <Input
                  placeholder={t('profile.ticket_message_placeholder')}
                  value={messageText}
                  onChangeText={setMessageText}
                  multiline
                  className="mb-0"
                />
              </View>
              <IconButton
                icon="send"
                variant={messageText.trim() ? 'primary' : 'secondary'}
                size="md"
                onPress={handleSend}
                disabled={!messageText.trim() || sending}
              />
            </View>
          ) : (
            <View className="px-4 py-3 border-t border-neutral-100 bg-neutral-50">
              <Text variant="bodySmall" color="tertiary" className="text-center">
                {t('profile.ticket_closed_message', { status: STATUS_LABELS[ticket?.status ?? 'closed'] })}
              </Text>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
