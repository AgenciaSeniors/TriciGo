import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { authService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';

export default function DriverProfileScreen() {
  const { t } = useTranslation('common');
  const { t: td } = useTranslation('driver');
  const user = useAuthStore((s) => s.user);
  const reset = useAuthStore((s) => s.reset);
  const driverProfile = useDriverStore((s) => s.profile);
  const resetDriver = useDriverStore((s) => s.reset);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await authService.signOut();
      reset();
      resetDriver();
    } catch {
      // Still reset locally even if API call fails
      reset();
      resetDriver();
    } finally {
      setLoggingOut(false);
    }
  };

  const menuItems = [
    { icon: 'person-outline' as const, label: t('profile.edit_profile'), onPress: () => router.push('/profile/edit') },
    { icon: 'car-outline' as const, label: t('profile.vehicle_info'), onPress: () => router.push('/profile/vehicle') },
    { icon: 'document-text-outline' as const, label: t('profile.documents'), onPress: () => router.push('/profile/documents') },
    { icon: 'shield-checkmark-outline' as const, label: t('safety.title'), onPress: () => router.push('/profile/safety') },
    { icon: 'gift-outline' as const, label: t('profile.referral_title'), onPress: () => router.push('/profile/referral') },
    { icon: 'language-outline' as const, label: t('profile.language'), onPress: () => router.push('/profile/settings') },
    { icon: 'settings-outline' as const, label: t('profile.settings'), onPress: () => router.push('/profile/settings') },
    { icon: 'help-circle-outline' as const, label: t('profile.help'), onPress: () => router.push('/profile/help') },
  ];

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <Text variant="h3" color="inverse" className="mb-6">
          {t('profile.title')}
        </Text>

        <Card variant="filled" padding="md" className="mb-6 flex-row items-center bg-neutral-800">
          <View className="w-14 h-14 rounded-full bg-primary-500 items-center justify-center mr-4">
            <Text variant="h4" color="inverse">
              {user?.full_name?.charAt(0) ?? 'C'}
            </Text>
          </View>
          <View className="flex-1">
            <Text variant="h4" color="inverse">{user?.full_name ?? td('common.driver_label')}</Text>
            <Text variant="bodySmall" color="inverse" className="opacity-50">
              {user?.phone ?? '+53 5XXXXXXX'}
            </Text>
          </View>
        </Card>

        {driverProfile ? (
          <Card variant="filled" padding="md" className="mb-6 bg-neutral-800">
            <View className="flex-row justify-between">
              <View className="items-center flex-1">
                <Text variant="h4" color="accent">
                  {driverProfile.status ?? '--'}
                </Text>
                <Text variant="bodySmall" color="inverse" className="opacity-50">
                  {td('common.status_label')}
                </Text>
              </View>
              <View className="items-center flex-1">
                <Text variant="h4" color="accent">
                  {driverProfile.rating_avg?.toFixed(1) ?? '--'}
                </Text>
                <Text variant="bodySmall" color="inverse" className="opacity-50">
                  {td('earnings.rating')}
                </Text>
              </View>
              <View className="items-center flex-1">
                <Text variant="h4" color="accent">
                  {driverProfile.total_rides ?? 0}
                </Text>
                <Text variant="bodySmall" color="inverse" className="opacity-50">
                  {td('trips_history.title')}
                </Text>
              </View>
            </View>
          </Card>
        ) : null}

        {menuItems.map((item) => (
          <Pressable
            key={item.label}
            className="flex-row items-center py-4 border-b border-neutral-800"
            onPress={item.onPress}
          >
            <Ionicons name={item.icon} size={22} color={colors.neutral[400]} />
            <Text variant="body" color="inverse" className="ml-3 flex-1">
              {item.label}
            </Text>
            <Ionicons name="chevron-forward" size={20} color={colors.neutral[600]} />
          </Pressable>
        ))}

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
