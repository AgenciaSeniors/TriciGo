import React, { useState } from 'react';
import { View, Pressable, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import { authService, driverService } from '@tricigo/api';
import { Platform } from 'react-native';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useNotificationStore } from '@/stores/notification.store';

// TEMP: Static web version for Play Store screenshots
function WebDriverProfileScreen() {
  const menuItems = [
    { icon: 'person-outline' as const, label: 'Editar perfil' },
    { icon: 'car-outline' as const, label: 'Info del vehículo' },
    { icon: 'document-text-outline' as const, label: 'Documentos' },
    { icon: 'shield-checkmark-outline' as const, label: 'Seguridad' },
    { icon: 'gift-outline' as const, label: 'Referir amigos' },
    { icon: 'language-outline' as const, label: 'Idioma' },
    { icon: 'settings-outline' as const, label: 'Configuración' },
    { icon: 'help-circle-outline' as const, label: 'Ayuda' },
  ];
  return (
    <Screen scroll bg="dark" padded>
      <View className="pt-4">
        <Text variant="h3" color="inverse" className="mb-6">Perfil</Text>
        <Card variant="filled" padding="md" className="mb-6 flex-row items-center bg-neutral-800">
          <View className="w-14 h-14 rounded-full bg-primary-500 items-center justify-center mr-4">
            <Text variant="h4" color="inverse">J</Text>
          </View>
          <View className="flex-1">
            <Text variant="body" color="inverse" className="font-semibold">Juan Pérez</Text>
            <Text variant="caption" className="text-neutral-400">+53 55123456</Text>
            <View className="flex-row items-center mt-1">
              <Ionicons name="star" size={14} color={colors.brand.orange} />
              <Text variant="caption" className="text-neutral-300 ml-1">4.87 — 342 viajes</Text>
            </View>
          </View>
        </Card>
        {menuItems.map((item, i) => (
          <Pressable key={i} className="flex-row items-center py-4 border-b border-neutral-800">
            <Ionicons name={item.icon} size={22} color="#9ca3af" />
            <Text variant="body" color="inverse" className="flex-1 ml-4">{item.label}</Text>
            <Ionicons name="chevron-forward" size={18} color="#6b7280" />
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

function NativeDriverProfileScreen() {
  const { t } = useTranslation('common');
  const { t: td } = useTranslation('driver');
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const reset = useAuthStore((s) => s.reset);
  const driverProfile = useDriverStore((s) => s.profile);
  const resetDriver = useDriverStore((s) => s.reset);
  const resetNotifications = useNotificationStore((s) => s.reset);
  const [loggingOut, setLoggingOut] = useState(false);

  if (isLoading) {
    return (
      <Screen scroll bg="dark" statusBarStyle="light-content" padded>
        <View className="pt-4">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={3} />
        </View>
      </Screen>
    );
  }

  const doLogout = async () => {
    setLoggingOut(true);
    try {
      // Mark driver offline before signing out so backend stops routing rides
      if (driverProfile?.id) {
        await driverService.setOnlineStatus(driverProfile.id, false).catch(() => {});
      }
      await authService.signOut();
      reset();
      resetDriver();
      resetNotifications();
    } catch {
      // Still reset locally even if API call fails
      reset();
      resetDriver();
      resetNotifications();
    } finally {
      setLoggingOut(false);
    }
  };

  const handleLogout = () => {
    Alert.alert(
      td('profile.logout_confirm_title', { defaultValue: 'Cerrar sesión' }),
      td('profile.logout_confirm_msg', { defaultValue: '¿Estás seguro? Dejarás de recibir viajes.' }),
      [
        { text: t('cancel'), style: 'cancel' },
        { text: td('profile.logout', { defaultValue: 'Cerrar sesión' }), style: 'destructive', onPress: doLogout },
      ],
    );
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

export default function DriverProfileScreen() {
  if (Platform.OS === 'web') return <WebDriverProfileScreen />;
  return <NativeDriverProfileScreen />;
}
