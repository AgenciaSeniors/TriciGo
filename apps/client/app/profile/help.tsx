import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Pressable, FlatList, RefreshControl } from 'react-native';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { Input } from '@tricigo/ui/Input';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { colors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { supportService } from '@tricigo/api';
import { getErrorMessage, logger, triggerHaptic, formatTimestamp } from '@tricigo/utils';
import { SkeletonListItem } from '@tricigo/ui/Skeleton';
import { useAuthStore } from '@/stores/auth.store';
import { ErrorState } from '@tricigo/ui/ErrorState';
import type { SupportTicket, TicketCategory } from '@tricigo/types';

const FAQ_KEYS = [
  'faq_q1', 'faq_q2', 'faq_q3', 'faq_q4', 'faq_q5',
  'faq_q6', 'faq_q7', 'faq_q8', 'faq_q9', 'faq_q10',
] as const;

const CATEGORY_KEYS: { value: TicketCategory; key: string }[] = [
  { value: 'ride_issue', key: 'profile.help_category_ride_issue' },
  { value: 'payment_issue', key: 'profile.help_category_payment_issue' },
  { value: 'driver_complaint', key: 'profile.help_category_driver_complaint' },
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

export default function HelpScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [faqSearch, setFaqSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimeoutRef = useRef<NodeJS.Timeout>();

  const handleSearchChange = (text: string) => {
    setFaqSearch(text);
    setExpandedIdx(null);
    clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => setDebouncedSearch(text), 300);
  };

  // Tickets state
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [refreshing, setRefreshing] = useState(false);

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
      setError(getErrorMessage(err));
    } finally {
      setLoadingTickets(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchTickets();
    setRefreshing(false);
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
      Toast.show({ type: 'success', text1: t('profile.help_ticket_created') });
      triggerHaptic('success');
      fetchTickets();
    } catch (err) {
      logger.warn('[Help] Failed to create ticket', { error: String(err) });
      Toast.show({ type: 'error', text1: t('profile.help_ticket_error') });
    } finally {
      setSubmitting(false);
    }
  };

  const renderTicket = ({ item }: { item: SupportTicket }) => {
    const status = STATUS_COLORS[item.status] ?? { bg: 'bg-yellow-100', text: 'text-yellow-700', key: 'profile.help_status_open' };
    return (
      <Pressable onPress={() => router.push(`/profile/ticket-detail?ticketId=${item.id}`)}>
        <Card variant="outlined" padding="md" className="mb-2">
          <View className="flex-row items-start justify-between">
            <View className="flex-1 mr-2">
              <Text variant="body" className="font-semibold" numberOfLines={1}>
                {item.subject}
              </Text>
              <Text variant="caption" color="tertiary" className="mt-0.5">
                {formatTimestamp(item.created_at, 'short')}
              </Text>
            </View>
            <StatusBadge
              label={t(status.key)}
              variant={item.status === 'resolved' ? 'success' : item.status === 'closed' ? 'neutral' : item.status === 'in_progress' ? 'info' : item.status === 'waiting_user' ? 'warning' : 'warning'}
            />
          </View>
        </Card>
      </Pressable>
    );
  };

  if (error) return <ErrorState title="Error" description={error} onRetry={() => { setError(null); fetchTickets(); }} />;

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <ScreenHeader title={t('profile.help_title')} onBack={() => router.back()} />

        <FlatList
          data={tickets}
          keyExtractor={(item) => item.id}
          renderItem={renderTicket}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.brand.orange} />
          }
          ListHeaderComponent={
            <View>
              {/* FAQ Section */}
              <Text variant="h4" className="mb-3">{t('profile.help_faq_title')}</Text>

              {/* FAQ Search */}
              <Input
                placeholder={t('profile.help_search_faqs')}
                value={faqSearch}
                onChangeText={handleSearchChange}
                className="mb-3"
              />

              {(() => {
                const query = debouncedSearch.trim().toLowerCase();
                const filtered = FAQ_KEYS.filter((key) => {
                  if (!query) return true;
                  const question = t(`profile.${key}`).toLowerCase();
                  const answerKey = key.replace('_q', '_a');
                  const answer = t(`profile.${answerKey}`).toLowerCase();
                  return question.includes(query) || answer.includes(query);
                });

                if (filtered.length === 0) {
                  return (
                    <View className="py-4 items-center">
                      <Text variant="bodySmall" color="tertiary">{t('profile.help_no_faq_results')}</Text>
                    </View>
                  );
                }

                return filtered.map((key, idx) => {
                  const answerKey = key.replace('_q', '_a');
                  const isExpanded = expandedIdx === idx;
                  return (
                    <Card key={key} variant="outlined" padding="md" className="mb-3">
                      <Pressable
                        onPress={() => setExpandedIdx(isExpanded ? null : idx)}
                        className="flex-row items-center justify-between"
                        accessibilityRole="button"
                        accessibilityState={{ expanded: isExpanded }}
                      >
                        <Text variant="body" className="flex-1 mr-2">
                          {t(`profile.${key}`)}
                        </Text>
                        <Ionicons
                          name={isExpanded ? 'chevron-up' : 'chevron-down'}
                          size={20}
                          color={colors.neutral[400]}
                        />
                      </Pressable>
                      {isExpanded && (
                        <Text variant="bodySmall" color="secondary" className="mt-2">
                          {t(`profile.${answerKey}`)}
                        </Text>
                      )}
                    </Card>
                  );
                });
              })()}

              {/* Contact info */}
              <Card variant="outlined" padding="md" className="mt-1 mb-6">
                <Text variant="body" className="font-semibold mb-2">{t('profile.help_contact')}</Text>
                <View className="flex-row items-center mb-1">
                  <Ionicons name="mail-outline" size={18} color={colors.neutral[600]} />
                  <Text variant="bodySmall" color="secondary" className="ml-2">soporte@tricigo.app</Text>
                </View>
                <View className="flex-row items-center">
                  <Ionicons name="call-outline" size={18} color={colors.neutral[600]} />
                  <Text variant="bodySmall" color="secondary" className="ml-2">+53 5XXXXXXX</Text>
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
                <Text variant="h4" className="mb-3">{t('profile.help_my_tickets')}</Text>
              )}
            </View>
          }
          ListEmptyComponent={
            loadingTickets ? (
              <View>
                <SkeletonListItem />
                <SkeletonListItem />
                <SkeletonListItem />
              </View>
            ) : (
              <EmptyState
                icon="chatbubble-ellipses-outline"
                title={t('profile.help_no_tickets')}
              />
            )
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
                  category === cat.value ? 'bg-primary-500' : 'bg-neutral-100'
                }`}
              >
                <Text
                  variant="caption"
                  className={`font-medium ${
                    category === cat.value ? 'text-white' : 'text-neutral-600'
                  }`}
                >
                  {t(cat.key)}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Subject */}
          <Text variant="bodySmall" color="secondary" className="mb-2">{t('profile.help_subject_label')}</Text>
          <Input
            placeholder={t('profile.help_subject_placeholder')}
            value={subject}
            onChangeText={setSubject}
            maxLength={100}
          />

          {/* Description */}
          <Text variant="bodySmall" color="secondary" className="mb-2">{t('profile.help_description_label')}</Text>
          <Input
            placeholder={t('profile.help_description_placeholder')}
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={4}
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
