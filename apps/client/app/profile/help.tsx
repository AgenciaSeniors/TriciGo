import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Pressable, FlatList, RefreshControl } from 'react-native';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { Input } from '@tricigo/ui/Input';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { useTokens } from '@/hooks/useTokens';
import { useThemeStore } from '@/stores/theme.store';
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
  const tokens = useTokens();
  const isDark = useThemeStore((s) => s.resolvedScheme) === 'dark';
  const CARD_SHADOW = {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.4 : 0.06,
    shadowRadius: 8,
    elevation: 2,
  };
  const userId = useAuthStore((s) => s.user?.id);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [faqSearch, setFaqSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // Bugfix: `NodeJS.Timeout` isn't available in React-Native's global
  // type surface, which made tsc fail here. `setTimeout`'s return type
  // portably covers both RN and Node, and `clearTimeout` needs an arg
  // when called — passing `undefined` is a no-op under the spec and the
  // real runtime, so wrap the call so the ref's first-render `null`
  // doesn't throw in strict mode.
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchChange = (text: string) => {
    setFaqSearch(text);
    setExpandedIdx(null);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
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
    triggerHaptic('light');
    setCategory('ride_issue');
    setSubject('');
    setDescription('');
    setSheetVisible(true);
  };

  const submitTicket = async () => {
    if (!userId) return;
    // UX: silent return when subject was empty left the Submit button
    // feeling unresponsive. Nudge the user toward the required field
    // with a warning haptic + info toast, matching the edit.tsx and
    // emergency-contact.tsx patterns.
    if (!subject.trim()) {
      triggerHaptic('warning');
      Toast.show({
        type: 'info',
        text1: t('profile.help_subject_required', { defaultValue: 'Ingresá un asunto para tu ticket' }),
      });
      return;
    }
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
        <View style={{ backgroundColor: tokens.bg.elev1, borderRadius: 14, padding: 14, marginBottom: 8, ...CARD_SHADOW }}>
          <View className="flex-row items-start justify-between">
            <View className="flex-1 mr-2">
              <Text variant="body" className="font-semibold" numberOfLines={1} style={{ color: tokens.ink.primary }}>
                {item.subject}
              </Text>
              <Text variant="caption" style={{ color: tokens.ink.subtle, marginTop: 2 }}>
                {formatTimestamp(item.created_at, 'short')}
              </Text>
            </View>
            <StatusBadge
              label={t(status.key)}
              variant={item.status === 'resolved' ? 'success' : item.status === 'closed' ? 'neutral' : item.status === 'in_progress' ? 'info' : item.status === 'waiting_user' ? 'warning' : 'warning'}
            />
          </View>
        </View>
      </Pressable>
    );
  };

  if (error) return <ErrorState title="Error" description={error} onRetry={() => { setError(null); fetchTickets(); }} />;

  return (
    <Screen bg="cuban" padded>
      <View className="pt-4 flex-1">
        <ScreenHeader title={t('profile.help_title')} onBack={() => router.back()} />

        <FlatList
          data={tickets}
          keyExtractor={(item) => item.id}
          renderItem={renderTicket}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={tokens.accent.orange} />
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
                    <View key={key} style={{ backgroundColor: tokens.bg.elev1, borderRadius: 14, padding: 14, marginBottom: 12, ...CARD_SHADOW }}>
                      <Pressable
                        onPress={() => setExpandedIdx(isExpanded ? null : idx)}
                        className="flex-row items-center justify-between"
                        accessibilityRole="button"
                        accessibilityState={{ expanded: isExpanded }}
                      >
                        <Text variant="body" className="flex-1 mr-2" style={{ color: tokens.ink.primary }}>
                          {t(`profile.${key}`)}
                        </Text>
                        <Ionicons
                          name={isExpanded ? 'chevron-up' : 'chevron-down'}
                          size={20}
                          color={tokens.ink.subtle}
                        />
                      </Pressable>
                      {isExpanded && (
                        <Text variant="bodySmall" style={{ color: tokens.ink.secondary, marginTop: 8 }}>
                          {t(`profile.${answerKey}`)}
                        </Text>
                      )}
                    </View>
                  );
                });
              })()}

              {/* Contact info */}
              <View style={{ backgroundColor: tokens.bg.elev1, borderRadius: 16, padding: 16, marginTop: 4, marginBottom: 24, ...CARD_SHADOW }}>
                <Text variant="body" className="font-semibold mb-2" style={{ color: tokens.ink.primary }}>{t('profile.help_contact')}</Text>
                <View className="flex-row items-center mb-1">
                  <Ionicons name="mail-outline" size={18} color={tokens.ink.secondary} />
                  <Text variant="bodySmall" style={{ color: tokens.ink.secondary, marginLeft: 8 }}>soporte@tricigo.com</Text>
                </View>
                <View className="flex-row items-center">
                  <Ionicons name="call-outline" size={18} color={tokens.ink.secondary} />
                  <Text variant="bodySmall" style={{ color: tokens.ink.secondary, marginLeft: 8 }}>+53 5XXXXXXX</Text>
                </View>
              </View>

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
            {CATEGORY_KEYS.map((cat) => {
              const active = category === cat.value;
              return (
                <Pressable
                  key={cat.value}
                  onPress={() => setCategory(cat.value)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 999,
                    backgroundColor: active ? tokens.accent.orange : tokens.bg.elev2,
                  }}
                >
                  <Text variant="caption" style={{ fontWeight: '600', color: active ? '#FFFFFF' : tokens.ink.secondary }}>
                    {t(cat.key)}
                  </Text>
                </Pressable>
              );
            })}
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
