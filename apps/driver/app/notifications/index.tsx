import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, Pressable, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { useTranslation } from '@tricigo/i18n';
import { notificationService } from '@tricigo/api';
import { colors } from '@tricigo/theme';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '@/stores/auth.store';
import { useNotificationStore } from '@/stores/notification.store';
import type { AppNotification, NotificationType } from '@tricigo/types';

const ICON_MAP: Record<NotificationType, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
  ride_update: { name: 'car', color: colors.brand.orange },
  ride_completed: { name: 'checkmark-circle', color: '#16a34a' },
  ride_canceled: { name: 'close-circle', color: '#dc2626' },
  driver_assigned: { name: 'navigate', color: colors.brand.orange },
  driver_arriving: { name: 'location', color: '#2563eb' },
  dispute_update: { name: 'alert-circle', color: '#ea580c' },
  wallet_credit: { name: 'arrow-down-circle', color: '#16a34a' },
  wallet_debit: { name: 'arrow-up-circle', color: '#dc2626' },
  promo: { name: 'gift', color: '#7c3aed' },
  referral_reward: { name: 'people', color: '#2563eb' },
  quest_completed: { name: 'trophy', color: '#ca8a04' },
  system: { name: 'information-circle', color: '#6b7280' },
};

function timeAgo(dateStr: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('notifications.now', { defaultValue: 'Ahora' });
  if (mins < 60) return `${mins}${t('notifications.minutes_short', { defaultValue: 'm' })}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}${t('notifications.hours_short', { defaultValue: 'h' })}`;
  const days = Math.floor(hours / 24);
  return `${days}${t('notifications.days_short', { defaultValue: 'd' })}`;
}

function getDateGroup(dateStr: string, t: (key: string) => string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);

  if (d >= today) return t('notifications.today');
  if (d >= yesterday) return t('notifications.yesterday');
  return t('notifications.older');
}

export default function NotificationsScreen() {
  const { t } = useTranslation('driver');
  const user = useAuthStore((s) => s.user);
  const {
    notifications, isLoading, setNotifications, appendNotifications,
    markRead, markAllRead, setLoading, setUnreadCount, decrementUnread,
  } = useNotificationStore();

  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(true);

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
      console.error('Error fetching notifications:', err);
    } finally {
      setLoading(false);
    }
  }, [user?.id, filter, notifications.length]);

  useEffect(() => {
    fetchNotifications(true);
  }, [user?.id, filter]);

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
    } catch (err) {
      console.error('Error marking all as read:', err);
    }
  };

  const handleTap = async (notif: AppNotification) => {
    if (!notif.read) {
      try {
        await notificationService.markAsRead(notif.id);
        markRead(notif.id);
        decrementUnread();
      } catch { /* best effort */ }
    }

    // Deep link based on notification data
    const data = notif.data as Record<string, string> | null;
    if (data?.ride_id) {
      router.push(`/trip/${data.ride_id}`);
    }
  };

  const handleLoadMore = () => {
    if (!isLoading && hasMore) {
      fetchNotifications(false);
    }
  };

  const renderItem = ({ item }: { item: AppNotification }) => {
    const icon = ICON_MAP[item.type] ?? ICON_MAP.system;
    return (
      <Pressable
        onPress={() => handleTap(item)}
        className={`flex-row px-4 py-3 border-b border-neutral-800 ${!item.read ? 'bg-neutral-800/50' : ''}`}
        accessibilityRole="button"
        accessibilityLabel={`${item.title}: ${item.body}`}
      >
        <View className="w-10 h-10 rounded-full items-center justify-center mr-3" style={{ backgroundColor: icon.color + '20' }}>
          <Ionicons name={icon.name} size={20} color={icon.color} />
        </View>
        <View className="flex-1 mr-2">
          <Text variant="bodySmall" color="inverse" className={`font-semibold ${!item.read ? '' : 'opacity-60'}`}>
            {item.title}
          </Text>
          <Text variant="caption" color="inverse" className="opacity-50" numberOfLines={2}>
            {item.body}
          </Text>
        </View>
        <View className="items-end">
          <Text variant="caption" color="inverse" className="opacity-40">{timeAgo(item.created_at, t)}</Text>
          {!item.read && (
            <View className="w-2 h-2 rounded-full bg-primary-500 mt-1" />
          )}
        </View>
      </Pressable>
    );
  };

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded={false}>
      <ScreenHeader
        title={t('notifications.title')}
        onBack={() => router.back()}
        rightAction={
          <Pressable onPress={handleMarkAllRead} className="px-2">
            <Text variant="caption" color="accent" className="font-semibold">
              {t('notifications.mark_all_read')}
            </Text>
          </Pressable>
        }
      />

      {/* Filter tabs */}
      <View className="flex-row px-4 pb-2 gap-2">
        {(['all', 'unread'] as const).map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full ${
              filter === f ? 'bg-primary-500' : 'bg-neutral-800'
            }`}
          >
            <Text
              variant="caption"
              className={`font-medium ${filter === f ? 'text-white' : 'text-neutral-400'}`}
            >
              {t(`notifications.${f}`)}
            </Text>
          </Pressable>
        ))}
      </View>

      {notifications.length === 0 && !isLoading ? (
        <EmptyState
          icon="notifications-off-outline"
          title={t('notifications.empty')}
          description={t('notifications.empty_desc')}
        />
      ) : (
        <FlatList
          data={notifications}
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
