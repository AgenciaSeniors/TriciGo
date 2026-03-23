import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';
import { authService } from '@tricigo/api';
import { router } from 'expo-router';
import type { UserLevel } from '@tricigo/types';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import { Platform } from 'react-native';
import { colors } from '@tricigo/theme';

// Web profile: uses real user data from auth store
function WebProfileScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const reset = useAuthStore((s) => s.reset);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await authService.signOut();
      await AsyncStorage.multiRemove([
        '@tricigo/notifications_enabled', '@tricigo/sms_enabled',
        '@tricigo/notification_pref_ride_updates', '@tricigo/notification_pref_promotions',
        '@tricigo/notification_pref_chat', '@tricigo/notification_pref_payment',
        '@tricigo/notification_permission_shown', '@tricigo/recent_addresses',
        '@tricigo/prediction_cache',
      ]).catch(() => {});
      reset();
    } catch { setLoggingOut(false); }
  };

  const initial = user?.full_name?.charAt(0)?.toUpperCase() ?? '?';
  const menuItems = [
    { icon: 'person-outline' as const, label: t('profile.edit_profile'), href: '/profile/edit' },
    { icon: 'settings-outline' as const, label: t('profile.settings', { defaultValue: 'Configuración' }), href: '/profile/settings' },
  ];

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <Text variant="h3" className="mb-6">{t('tabs.profile')}</Text>
        <Card variant="filled" padding="md" className="mb-6 flex-row items-center">
          <View className="w-14 h-14 rounded-full bg-primary-500 items-center justify-center mr-4">
            <Text variant="h4" color="inverse">{initial}</Text>
          </View>
          <View className="flex-1">
            <Text variant="h4">{user?.full_name ?? t('common.no_name', { defaultValue: 'Sin nombre' })}</Text>
            <Text variant="caption" color="secondary">{user?.email ?? ''}</Text>
          </View>
        </Card>
        {menuItems.map((item, i) => (
          <Pressable key={i} className="flex-row items-center py-4 border-b border-neutral-100"
            onPress={() => router.push(item.href as string)}>
            <Ionicons name={item.icon} size={22} color={colors.neutral[500]} />
            <Text variant="body" className="flex-1 ml-4">{item.label}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.neutral[400]} />
          </Pressable>
        ))}
        <Pressable className="flex-row items-center py-4 mt-4" onPress={handleLogout} disabled={loggingOut}>
          <Ionicons name="log-out-outline" size={22} color={colors.error.DEFAULT} />
          <Text variant="body" className="flex-1 ml-4 text-red-500">
            {loggingOut ? t('common.processing') : t('profile.logout', { defaultValue: 'Cerrar sesión' })}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

function NativeProfileScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const reset = useAuthStore((s) => s.reset);
  const [loggingOut, setLoggingOut] = useState(false);

  if (isLoading) {
    return (
      <Screen scroll bg="white" padded>
        <View className="pt-4">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={3} />
        </View>
      </Screen>
    );
  }

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await authService.signOut();
      // Clear sensitive data from AsyncStorage
      const keysToRemove = [
        '@tricigo/notifications_enabled',
        '@tricigo/sms_enabled',
        '@tricigo/notification_pref_ride_updates',
        '@tricigo/notification_pref_promotions',
        '@tricigo/notification_pref_chat',
        '@tricigo/notification_pref_payment',
        '@tricigo/notification_permission_shown',
        '@tricigo/recent_addresses',
        '@tricigo/prediction_cache',
      ];
      await AsyncStorage.multiRemove(keysToRemove).catch(() => {});
      reset();
      // Auth guard handles redirect
    } catch {
      setLoggingOut(false);
    }
  };

  const menuItems = [
    { icon: 'person-outline' as const, label: t('profile.edit_profile'), onPress: () => router.push('/profile/edit') },
    { icon: 'location-outline' as const, label: t('profile.saved_locations'), onPress: () => router.push('/profile/saved-locations') },
    { icon: 'call-outline' as const, label: t('profile.emergency_contact'), onPress: () => router.push('/profile/emergency-contact') },
    { icon: 'people-outline' as const, label: t('trusted_contacts.title'), onPress: () => router.push('/profile/trusted-contacts') },
    { icon: 'shield-checkmark-outline' as const, label: t('safety.title'), onPress: () => router.push('/profile/safety') },
    { icon: 'repeat-outline' as const, label: t('recurring_rides'), onPress: () => router.push('/profile/recurring-rides') },
    { icon: 'language-outline' as const, label: t('profile.language'), onPress: () => router.push('/profile/settings') },
    { icon: 'settings-outline' as const, label: t('profile.settings'), onPress: () => router.push('/profile/settings') },
    { icon: 'gift-outline' as const, label: t('profile.referral_title'), onPress: () => router.push('/profile/referral') },
    { icon: 'help-circle-outline' as const, label: t('profile.help'), onPress: () => router.push('/profile/help') },
    { icon: 'newspaper-outline' as const, label: t('profile.blog_title', { defaultValue: 'Blog' }), onPress: () => router.push('/profile/blog') },
    { icon: 'information-circle-outline' as const, label: t('profile.about'), onPress: () => router.push('/profile/about') },
  ];

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <Text variant="h3" className="mb-6">
          {t('profile.title')}
        </Text>

        {/* User info card */}
        <Card variant="filled" padding="md" className="mb-6 flex-row items-center">
          <View className="w-14 h-14 rounded-full bg-primary-500 items-center justify-center mr-4">
            <Text variant="h4" color="inverse">
              {user?.full_name?.charAt(0) ?? 'U'}
            </Text>
          </View>
          <View className="flex-1">
            <View className="flex-row items-center gap-2">
              <Text variant="h4">{user?.full_name ?? 'Usuario'}</Text>
              {user?.level && (
                <StatusBadge
                  label={t(`profile.level_${user.level}`)}
                  variant={user.level === 'oro' ? 'warning' : user.level === 'plata' ? 'neutral' : 'warning'}
                />
              )}
            </View>
            <Text variant="bodySmall" color="secondary">
              {user?.phone ?? '+53 5XXXXXXX'}
            </Text>
          </View>
        </Card>

        {/* Menu */}
        {menuItems.map((item) => (
          <Pressable
            key={item.label}
            className="flex-row items-center py-4 border-b border-neutral-100"
            onPress={item.onPress}
          >
            <Ionicons name={item.icon} size={22} color={colors.neutral[600]} />
            <Text variant="body" className="ml-3 flex-1">
              {item.label}
            </Text>
            <Ionicons name="chevron-forward" size={20} color={colors.neutral[400]} />
          </Pressable>
        ))}

        {/* Logout */}
        <Pressable
          className="flex-row items-center py-4 mt-4"
          onPress={handleLogout}
          disabled={loggingOut}
        >
          <Ionicons name="log-out-outline" size={22} color={colors.error.DEFAULT} />
          <Text variant="body" color="error" className="ml-3">
            {loggingOut ? t('auth.logging_out') : t('auth.logout')}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

export default function ProfileScreen() {
  if (Platform.OS === 'web') return <WebProfileScreen />;
  return <NativeProfileScreen />;
}
