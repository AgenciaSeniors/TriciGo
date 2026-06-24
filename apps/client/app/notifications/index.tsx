import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { View, FlatList, Pressable, RefreshControl, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { useTranslation } from '@tricigo/i18n';
import { notificationService } from '@tricigo/api';
import { colors } from '@tricigo/theme';
import { Ionicons } from '@expo/vector-icons';
import { logger, formatTimestamp, triggerHaptic } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import { useNotificationStore } from '@/stores/notification.store';
import type { AppNotification } from '@tricigo/types';
import { SkeletonListItem } from '@tricigo/ui/Skeleton';

// Keyed by the real notification categories send-push writes to
// notifications.type (ride, ride_offer, announcement, blog, promo…), NOT
// the legacy NotificationType enum — otherwise every real notification fell
// back to the generic 'system' icon. Unknown types still fall back below.
function buildIconMap(isDark: boolean): Record<string, { name: keyof typeof Ionicons.glyphMap; color: string }> {
  return {
    ride: { name: 'car', color: colors.brand.orange },
    ride_offer: { name: 'car', color: colors.brand.orange },
    ride_matching: { name: 'search', color: colors.brand.orange },
    proximity: { name: 'navigate', color: isDark ? '#60A5FA' : '#2563eb' },
    chat: { name: 'chatbubble', color: isDark ? '#60A5FA' : '#2563eb' },
    payment: { name: 'card', color: isDark ? '#4ADE80' : '#16a34a' },
    wallet_recharge: { name: 'arrow-down-circle', color: isDark ? '#4ADE80' : '#16a34a' },
    wallet_recharge_refund: { name: 'arrow-undo', color: colors.brand.orange },
    wallet_credit: { name: 'arrow-down-circle', color: isDark ? '#4ADE80' : '#16a34a' },
    wallet_debit: { name: 'arrow-up-circle', color: isDark ? '#F87171' : '#dc2626' },
    lost_item: { name: 'search', color: colors.brand.orange },
    dispute_update: { name: 'alert-circle', color: isDark ? '#FB923C' : '#ea580c' },
    scheduled_ride: { name: 'calendar', color: isDark ? '#60A5FA' : '#2563eb' },
    sos: { name: 'warning', color: isDark ? '#F87171' : '#dc2626' },
    delivery: { name: 'cube', color: colors.brand.orange },
    announcement: { name: 'megaphone', color: isDark ? '#A78BFA' : '#7c3aed' },
    blog: { name: 'newspaper', color: isDark ? '#60A5FA' : '#2563eb' },
    news: { name: 'newspaper', color: isDark ? '#60A5FA' : '#2563eb' },
    promo: { name: 'gift', color: isDark ? '#A78BFA' : '#7c3aed' },
    campaign: { name: 'megaphone', color: isDark ? '#A78BFA' : '#7c3aed' },
    system: { name: 'information-circle', color: isDark ? '#9CA3AF' : '#6b7280' },
  };
}

// Defensive fallback for any category not in the map above (tsconfig has
// noUncheckedIndexedAccess, so the lookup is T | undefined).
const FALLBACK_ICON: { name: keyof typeof Ionicons.glyphMap; color: string } = {
  name: 'information-circle',
  color: '#6b7280',
};

function timeAgo(dateStr: string): string {
  return formatTimestamp(dateStr, 'relative');
}

export default function NotificationsScreen() {
  const { t } = useTranslation('rider');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const ICON_MAP = useMemo(() => buildIconMap(isDark), [isDark]);
  const user = useAuthStore((s) => s.user);
  const {
    notifications, isLoading, setNotifications, appendNotifications,
    markRead, markAllRead, setLoading, setUnreadCount, decrementUnread,
  } = useNotificationStore();

  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const isLoadingMore = useRef(false);

  const fetchNotifications = useCallback(async (reset = false) => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const offset = reset ? 0 : notifications.length;
      const data = await notificationService.getInboxNotifications(user.id, {
        unreadOnly: filter === 'unread',
        limit: 20,
        offset,
      });
      if (reset) {
        setNotifications(data);
      } else {
        appendNotifications(data);
      }
      setHasMore(data.length === 20);
    } catch (err) {
      logger.error('Error fetching notifications', { error: String(err) });
    } finally {
      setLoading(false);
    }
  }, [user?.id, filter, notifications.length]);

  useEffect(() => {
    fetchNotifications(true);
  }, [user?.id, filter]);

  // Stale-on-mount: reload the inbox on focus / app foreground — a new
  // notification should appear without a full restart. (fetchNotifications is an
  // unstable callback; useRefreshOnFocus holds it in a ref so this is loop-safe.)
  const refetchInbox = useCallback(() => { fetchNotifications(true); }, [fetchNotifications]);
  useRefreshOnFocus(refetchInbox);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchNotifications(true);
    if (user?.id) {
      const count = await notificationService.getUnreadCount(user.id);
      setUnreadCount(count);
    }
    setRefreshing(false);
  };

  const handleMarkAllRead = async () => {
    if (!user?.id) return;
    try {
      await notificationService.markAllAsRead(user.id);
      markAllRead();
      // UX: silent "everything marked read" left the user wondering
      // if it actually did anything. A light haptic + toast closes
      // the action loop, same pattern as R5/R6.
      triggerHaptic('light');
      Toast.show({
        type: 'success',
        text1: t('notifications.mark_all_read_toast', { defaultValue: 'Todas marcadas como leídas' }),
        visibilityTime: 2000,
      });
    } catch (err) {
      logger.error('Error marking all as read', { error: String(err) });
      Toast.show({ type: 'error', text1: t('errors.generic', { ns: 'common', defaultValue: 'Error' }) });
    }
  };

  const handleTap = async (notif: AppNotification) => {
    // UX: a light haptic confirms the tap was registered even before
    // the markAsRead call round-trips.
    triggerHaptic('light');
    if (!notif.read) {
      try {
        await notificationService.markAsRead(notif.id);
        markRead(notif.id);
        decrementUnread();
      } catch { /* best effort */ }
    }

    // Deep link based on notification data / category.
    const data = notif.data as Record<string, string> | null;
    // Chat notifications carry ride_id but must open the conversation, not
    // the ride screen (matches the OS push-tap handler).
    if (((notif.type as string) === 'chat' || data?.type === 'chat') && data?.ride_id) {
      router.push(`/chat/${data.ride_id}`);
      return;
    }
    if (data?.ride_id) {
      router.push(`/ride/${data.ride_id}`);
      return;
    }
    if (['wallet', 'payment', 'wallet_recharge', 'wallet_recharge_refund', 'wallet_credit', 'wallet_debit'].includes(notif.type)) {
      router.push('/(tabs)/wallet');
    } else {
      // Content (promo/announcement/blog/news) + fallback open home.
      router.push('/(tabs)');
    }
  };

  const handleLoadMore = () => {
    if (!isLoading && hasMore && !isLoadingMore.current) {
      isLoadingMore.current = true;
      fetchNotifications(false).finally(() => {
        isLoadingMore.current = false;
      });
    }
  };

  const filtered = filter === 'unread'
    ? notifications.filter(n => !n.read)
    : notifications;
  // UX / cleanup: the sections memo that grouped notifications by
  // "Hoy / Ayer / Antes" was computed on every render but never
  // consumed — the FlatList below rendered the flat array. Removed to
  // stop paying the allocation + keep the component honest. If/when
  // date separators ship, wire them through a SectionList instead.

  const renderItem = ({ item }: { item: AppNotification }) => {
    const icon = ICON_MAP[item.type] ?? FALLBACK_ICON;
    return (
      <Pressable
        onPress={() => handleTap(item)}
        className={`flex-row px-4 py-3 border-b border-neutral-100 dark:border-neutral-800 ${!item.read ? 'bg-orange-50/50 dark:bg-orange-950/30' : ''}`}
        accessibilityRole="button"
        accessibilityLabel={`${item.title}: ${item.body}`}
      >
        <View className="w-10 h-10 rounded-full items-center justify-center mr-3" style={{ backgroundColor: icon.color ? `${icon.color}20` : 'transparent' }}>
          <Ionicons name={icon.name} size={20} color={icon.color} />
        </View>
        <View className="flex-1 mr-2">
          <Text variant="bodySmall" className={`font-semibold ${!item.read ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-600 dark:text-neutral-400'}`}>
            {item.title}
          </Text>
          <Text variant="caption" color="secondary" numberOfLines={2}>
            {item.body}
          </Text>
        </View>
        <View className="items-end">
          <Text variant="caption" color="tertiary">{timeAgo(item.created_at)}</Text>
          {!item.read && (
            <View className="w-2 h-2 rounded-full bg-primary-500 mt-1" />
          )}
        </View>
      </Pressable>
    );
  };

  return (
    <Screen bg="cuban" padded={false}>
      <ScreenHeader
        title={t('notifications.title')}
        onBack={() => router.back()}
        rightAction={
          /* UX: the "mark all read" action used to render even when
               there were no unread notifications — tapping did nothing
               visible because the server had nothing to mark. Hide the
               affordance when it's a no-op so it stops feeling broken. */
          notifications.some((n) => !n.read) ? (
            <Pressable onPress={handleMarkAllRead} className="px-2">
              <Text variant="caption" color="primary" className="font-semibold">
                {t('notifications.mark_all_read')}
              </Text>
            </Pressable>
          ) : undefined
        }
      />

      {/* Filter tabs */}
      <View className="flex-row px-4 pb-2 gap-2">
        {(['all', 'unread'] as const).map((f) => (
          <Pressable
            key={f}
            onPress={() => {
              if (filter !== f) triggerHaptic('light');
              setFilter(f);
            }}
            className={`px-3 py-1.5 rounded-full ${
              filter === f ? 'bg-primary-500' : 'bg-neutral-100 dark:bg-neutral-800'
            }`}
          >
            <Text
              variant="caption"
              className={`font-medium ${filter === f ? 'text-white' : 'text-neutral-600 dark:text-neutral-400'}`}
            >
              {t(`notifications.${f}`)}
            </Text>
          </Pressable>
        ))}
      </View>

      {isLoading && filtered.length === 0 ? (
        <View className="px-4 pt-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonListItem key={i} />
          ))}
        </View>
      ) : filtered.length === 0 && !isLoading ? (
        /* UX: the same empty state fired whether the user had zero
             notifications or had filtered to "unread" while being fully
             caught up. Those are very different moods — reframe the
             "caught up" case as a positive instead of "sin
             notificaciones". Falls back to the generic copy when
             filter='all'. */
        filter === 'unread' && notifications.length > 0 ? (
          <EmptyState
            icon="checkmark-done-circle-outline"
            title={t('notifications.all_caught_up_title', { defaultValue: 'Todo al día' })}
            description={t('notifications.all_caught_up_desc', { defaultValue: 'No tenés notificaciones sin leer.' })}
            action={{
              label: t('notifications.show_all', { defaultValue: 'Ver todas' }),
              onPress: () => { triggerHaptic('light'); setFilter('all'); },
            }}
          />
        ) : (
          <EmptyState
            icon="notifications-off-outline"
            title={t('notifications.empty')}
            description={t('notifications.empty_desc')}
          />
        )
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.brand.orange} />
          }
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.3}
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      )}
    </Screen>
  );
}
