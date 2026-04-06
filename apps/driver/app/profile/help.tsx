import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, FlatList, Alert, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { useTranslation } from '@tricigo/i18n';
import { supportService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import type { SupportTicket, TicketCategory } from '@tricigo/types';

const FAQ_KEYS = ['faq_q1', 'faq_q2', 'faq_q3'] as const;

const CATEGORY_KEYS: { value: TicketCategory; key: string }[] = [
  { value: 'ride_issue', key: 'profile.help_category_ride_issue' },
  { value: 'payment_issue', key: 'profile.help_category_payment_issue' },
  { value: 'passenger_complaint', key: 'profile.help_category_passenger_complaint' },
  { value: 'account_issue', key: 'profile.help_category_account_issue' },
  { value: 'app_bug', key: 'profile.help_category_app_bug' },
  { value: 'other', key: 'profile.help_category_other' },
];

const STATUS_COLORS: Record<string, { bg: string; text: string; key: string }> = {
  open: { bg: 'bg-yellow-100', text: 'text-yellow-700', key: 'profile.help_status_open' },
  in_progress: { bg: 'bg-blue-100', text: 'text-blue-700', key: 'profile.help_status_in_progress' },
  waiting_user: { bg: 'bg-orange-100', text: 'text-orange-700', key: 'profile.help_status_waiting_response' },
  resolved: { bg: 'bg-green-100', text: 'text-green-700', key: 'profile.help_status_resolved' },
  closed: { bg: 'bg-neutral-100', text: 'text-neutral-600', key: 'profile.help_status_closed' },
};

export default function DriverHelpScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  // Tickets state
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(false);

  // Create ticket state
  const [sheetVisible, setSheetVisible] = useState(false);
  const [category, setCategory] = useState<TicketCategory>('ride_issue');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchTickets = useCallback(async () => {
    if (!userId) return;
    setLoadingTickets(true);
    try {
      const data = await supportService.getUserTickets(userId);
      setTickets(data);
    } catch (err) {
      console.warn('[Help] Failed to load tickets:', err);
    } finally {
      setLoadingTickets(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const handleCreateTicket = () => {
    setCategory('ride_issue');
    setSubject('');
    setDescription('');
    setSheetVisible(true);
  };

  const submitTicket = async () => {
    if (!userId || !subject.trim()) return;
    setSubmitting(true);
    try {
      await supportService.createTicket({
        user_id: userId,
        category,
        subject: subject.trim(),
        description: description.trim() || undefined,
      });
      setSheetVisible(false);
      Alert.alert(t('profile.help_title'), t('profile.help_ticket_created'));
      fetchTickets();
    } catch (err) {
      console.warn('[Help] Failed to create ticket:', err);
      Alert.alert(t('error'), t('profile.help_ticket_error'));
    } finally {
      setSubmitting(false);
    }
  };

  const renderTicket = ({ item }: { item: SupportTicket }) => {
    const status = STATUS_COLORS[item.status] ?? { bg: 'bg-yellow-100', text: 'text-yellow-700', key: 'profile.help_status_open' };
    return (
      <Pressable onPress={() => router.push(`/profile/ticket-detail?ticketId=${item.id}`)}>
        <Card forceDark variant="filled" padding="md" className="mb-2 bg-neutral-800">
          <View className="flex-row items-start justify-between">
            <View className="flex-1 mr-2">
              <Text variant="body" color="inverse" className="font-semibold" numberOfLines={1}>
                {item.subject}
              </Text>
              <Text variant="caption" color="inverse" className="mt-0.5 opacity-50">
                {new Date(item.created_at).toLocaleDateString('es-CU', {
                  day: 'numeric',
                  month: 'short',
                })}
              </Text>
            </View>
            <View className={`px-2 py-0.5 rounded-full ${status.bg}`}>
              <Text className={`text-xs font-medium ${status.text}`}>
                {t(status.key)}
              </Text>
            </View>
          </View>
        </Card>
      </Pressable>
    );
  };

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4 flex-1">
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color="#FAFAFA" />
          </Pressable>
          <Text variant="h3" color="inverse">{t('profile.help_title')}</Text>
        </View>

        <FlatList
          data={tickets}
          keyExtractor={(item) => item.id}
          renderItem={renderTicket}
          ListHeaderComponent={
            <View>
              {/* FAQ Section */}
              {FAQ_KEYS.map((key, idx) => {
                const answerKey = key.replace('_q', '_a') as `faq_a${1 | 2 | 3}`;
                const isExpanded = expandedIdx === idx;
                return (
                  <Card forceDark key={key} variant="filled" padding="md" className="mb-3 bg-neutral-800">
                    <Pressable
                      onPress={() => setExpandedIdx(isExpanded ? null : idx)}
                      className="flex-row items-center justify-between"
                    >
                      <Text variant="body" color="inverse" className="flex-1 mr-2">
                        {t(`profile.${key}`)}
                      </Text>
                      <Ionicons
                        name={isExpanded ? 'chevron-up' : 'chevron-down'}
                        size={20}
                        color="#A3A3A3"
                      />
                    </Pressable>
                    {isExpanded && (
                      <Text variant="bodySmall" color="inverse" className="mt-2 opacity-60">
                        {t(`profile.${answerKey}`)}
                      </Text>
                    )}
                  </Card>
                );
              })}

              {/* Contact info */}
              <Card forceDark variant="filled" padding="md" className="mt-1 mb-6 bg-neutral-800">
                <Text variant="body" color="inverse" className="font-semibold mb-2">{t('profile.help_contact')}</Text>
                <View className="flex-row items-center mb-1">
                  <Ionicons name="mail-outline" size={18} color="#A3A3A3" />
                  <Text variant="bodySmall" color="inverse" className="ml-2 opacity-60">soporte@tricigo.app</Text>
                </View>
                <View className="flex-row items-center">
                  <Ionicons name="call-outline" size={18} color="#A3A3A3" />
                  <Text variant="bodySmall" color="inverse" className="ml-2 opacity-60">+53 5XXXXXXX</Text>
                </View>
              </Card>

              {/* Create ticket button */}
              <Button
                title={t('profile.help_create_ticket')}
                variant="primary"
                size="lg"
                fullWidth
                onPress={handleCreateTicket}
                className="mb-6"
              />

              {/* Tickets header */}
              {tickets.length > 0 && (
                <Text variant="h4" color="inverse" className="mb-3">{t('profile.help_my_tickets')}</Text>
              )}
            </View>
          }
          ListEmptyComponent={
            !loadingTickets ? (
              <View className="items-center py-6">
                <Text variant="bodySmall" color="inverse" className="opacity-50">
                  {t('profile.help_no_tickets')}
                </Text>
              </View>
            ) : null
          }
        />
      </View>

      {/* Create Ticket BottomSheet */}
      <BottomSheet visible={sheetVisible} onClose={() => setSheetVisible(false)}>
        <View className="px-4 pb-6">
          <Text variant="h4" className="mb-4">{t('profile.help_new_ticket')}</Text>

          {/* Category picker */}
          <Text variant="bodySmall" color="secondary" className="mb-2">{t('profile.help_category_label')}</Text>
          <View className="flex-row flex-wrap gap-2 mb-4">
            {CATEGORY_KEYS.map((cat) => (
              <Pressable
                key={cat.value}
                onPress={() => setCategory(cat.value)}
                className={`px-3 py-1.5 rounded-full ${
                  category === cat.value ? 'bg-primary-500' : 'bg-neutral-700'
                }`}
              >
                <Text
                  variant="caption"
                  className={`font-medium ${
                    category === cat.value ? 'text-white' : 'text-neutral-300'
                  }`}
                >
                  {t(cat.key)}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Subject */}
          <Text variant="bodySmall" color="secondary" className="mb-2">{t('profile.help_subject_label')}</Text>
          <TextInput
            className="border border-neutral-200 rounded-lg p-3 mb-3 text-neutral-900"
            placeholder={t('profile.help_subject_placeholder')}
            value={subject}
            onChangeText={setSubject}
            maxLength={100}
          />

          {/* Description */}
          <Text variant="bodySmall" color="secondary" className="mb-2">{t('profile.help_description_label')}</Text>
          <TextInput
            className="border border-neutral-200 rounded-lg p-3 mb-4 text-neutral-900"
            placeholder={t('profile.help_description_placeholder')}
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            style={{ minHeight: 100 }}
          />

          <Button
            title={t('profile.help_submit_ticket')}
            variant="primary"
            size="lg"
            fullWidth
            onPress={submitTicket}
            loading={submitting}
            disabled={!subject.trim() || submitting}
          />
        </View>
      </BottomSheet>
    </Screen>
  );
}
