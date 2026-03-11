import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';
import { authService } from '@tricigo/api';
import { router } from 'expo-router';
import type { UserLevel } from '@tricigo/types';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { colors } from '@tricigo/theme';

export default function ProfileScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const reset = useAuthStore((s) => s.reset);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await authService.signOut();
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
    { icon: 'language-outline' as const, label: t('profile.language'), onPress: () => router.push('/profile/settings') },
    { icon: 'settings-outline' as const, label: t('profile.settings'), onPress: () => router.push('/profile/settings') },
    { icon: 'gift-outline' as const, label: t('profile.referral_title'), onPress: () => router.push('/profile/referral') },
    { icon: 'help-circle-outline' as const, label: t('profile.help'), onPress: () => router.push('/profile/help') },
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
