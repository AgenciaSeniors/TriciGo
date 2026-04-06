import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, FlatList, Pressable, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { Skeleton } from '@tricigo/ui/Skeleton';
import { useTranslation } from '@tricigo/i18n';
import { notificationService } from '@tricigo/api';
import { colors, driverDarkColors } from '@tricigo/theme';
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

function getDateGroup(dateStr: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);

  if (d >= today) return t('notifications.today', { defaultValue: 'Hoy' });
  if (d >= yesterday) return t('notifications.yesterday', { defaultValue: 'Ayer' });
  return t('notifications.older', { defaultValue: 'Anteriores' });
}

type GroupedNotification = { type: 'header'; title: string } | { type: 'item'; data: AppNotification };

function SkeletonNotification() {
  return (
    <View className="flex-row px-4 py-3.5 items-center">
      <View className="mr-3">
        <Skeleton width={40} height={40} borderRadius={20} style={{ backgroundColor: colors.neutral[800] }} />
      </View>
      <View className="flex-1">
        <Skeleton width="70%" height={14} className="mb-2" style={{ backgroundColor: colors.neutral[800] }} />
        <Skeleton width="90%" height={11} style={{ backgroundColor: colors.neutral[800] }} />
      </View>
      <Skeleton width={24} height={10} style={{ backgroundColor: colors.neutral[800] }} />
    </View>
  );
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

  // Group notifications by date
  const groupedData = useMemo((): GroupedNotification[] => {
    const filtered = notifications;
    if (filtered.length === 0) return [];

    const groups: GroupedNotification[] = [];
    let lastGroup = '';

    for (const notif of filtered) {
      const group = getDateGroup(notif.created_at, t);
      if (group !== lastGroup) {
        groups.push({ type: 'header', title: group });
        lastGroup = group;
      }
      groups.push({ type: 'item', data: notif });
    }

    return groups;
  }, [notifications, t]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const renderItem = ({ item }: { item: GroupedNotification }) => {
    if (item.type === 'header') {
      return (
        <View className="px-4 pt-4 pb-2">
          <Text variant="caption" style={{ color: colors.neutral[500] }} className="uppercase tracking-wider font-semibold">
            {item.title}
          </Text>
        </View>
      );
    }

    const notif = item.data;
    const icon = ICON_MAP[notif.type] ?? ICON_MAP.system;

    return (
      <Pressable
        onPress={() => handleTap(notif)}
        className="flex-row mx-3 px-3 py-3.5 rounded-xl mb-1"
        style={{
          backgroundColor: !notif.read ? `${driverDarkColors.card}` : 'transparent',
          borderWidth: !notif.read ? 1 : 0,
          borderColor: !notif.read ? driverDarkColors.border.default : 'transparent',
        }}
        accessibilityRole="button"
        accessibilityLabel={`${notif.title}: ${notif.body}`}
      >
        <View
          className="w-10 h-10 rounded-xl items-center justify-center mr-3"
          style={{ backgroundColor: icon.color + '18' }}
        >
          <Ionicons name={icon.name} size={20} color={icon.color} />
        </View>
        <View className="flex-1 mr-2">
          <Text
            variant="bodySmall"
            style={{ color: !notif.read ? '#f5f5f5' : colors.neutral[400], fontWeight: !notif.read ? '600' : '400' }}
          >
            {notif.title}
          </Text>
          <Text
            variant="caption"
            style={{ color: colors.neutral[500] }}
            numberOfLines={2}
            className="mt-0.5"
          >
            {notif.body}
          </Text>
        </View>
        <View className="items-end pt-0.5">
          <Text variant="caption" style={{ color: colors.neutral[600] }}>
            {timeAgo(notif.created_at, t)}
          </Text>
          {!notif.read && (
            <View
              className="w-2 h-2 rounded-full mt-2"
              style={{ backgroundColor: colors.brand.orange }}
            />
          )}
        </View>
      </Pressable>
    );
  };

  // Skeleton loading state
  if (isLoading && notifications.length === 0) {
    return (
      <Screen bg="dark" statusBarStyle="light-content" padded={false}>
        <ScreenHeader
          title={t('notifications.title')}
          onBack={() => router.back()}
          light
        />
        <View className="px-4 pt-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonNotification key={i} />
          ))}
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded={false}>
      <ScreenHeader
        title={t('notifications.title')}
        onBack={() => router.back()}
        light
        rightAction={
          unreadCount > 0 ? (
            <Pressable onPress={handleMarkAllRead} className="px-2" hitSlop={8}>
              <Text variant="caption" style={{ color: colors.brand.orange }} className="font-semibold">
                {t('notifications.mark_all_read')}
              </Text>
            </Pressable>
          ) : undefined
        }
      />

      {/* Filter tabs */}
      <View className="flex-row px-4 pb-3 gap-2">
        {(['all', 'unread'] as const).map((f) => {
          const isActive = filter === f;
          return (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              className="px-4 py-2 rounded-full flex-row items-center gap-1.5"
              style={{
                backgroundColor: isActive ? colors.brand.orange : driverDarkColors.card,
                borderWidth: 1,
                borderColor: isActive ? colors.brand.orange : driverDarkColors.border.default,
              }}
            >
              <Text
                variant="caption"
                style={{ color: isActive ? '#FFFFFF' : colors.neutral[400], fontWeight: '600' }}
              >
                {t(`notifications.${f}`)}
              </Text>
              {f === 'unread' && unreadCount > 0 && (
                <View
                  className="min-w-[18px] h-[18px] rounded-full items-center justify-center px-1"
                  style={{ backgroundColor: isActive ? 'rgba(255,255,255,0.25)' : colors.brand.orange }}
                >
                  <Text variant="badge" style={{ color: '#FFFFFF', fontSize: 10 }}>
                    {unreadCount > 99 ? '99+' : String(unreadCount)}
                  </Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {notifications.length === 0 && !isLoading ? (
        <EmptyState
          forceDark
          icon="notifications-off-outline"
          title={t('notifications.empty')}
          description={t('notifications.empty_desc')}
        />
      ) : (
        <FlatList
          data={groupedData}
          keyExtractor={(item, index) =>
            item.type === 'header' ? `header-${item.title}` : `notif-${item.data.id}`
          }
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
