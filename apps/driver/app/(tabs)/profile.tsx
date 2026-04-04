import React, { useState } from 'react';
import { View, Pressable, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { StatCard } from '@tricigo/ui/StatCard';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import { authService, driverService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useNotificationStore } from '@/stores/notification.store';

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
      if (driverProfile?.id) {
        await driverService.setOnlineStatus(driverProfile.id, false).catch(() => {});
      }
      await authService.signOut();
      reset();
      resetDriver();
      resetNotifications();
    } catch {
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

  const statusVariant = driverProfile?.status === 'approved' ? 'success'
    : driverProfile?.status === 'under_review' ? 'warning'
    : driverProfile?.status === 'suspended' ? 'error'
    : 'neutral';

  const menuSections = [
    {
      title: t('profile.section_account', { defaultValue: 'Cuenta' }),
      items: [
        { icon: 'person-outline' as const, label: t('profile.edit_profile'), onPress: () => router.push('/profile/edit') },
        { icon: 'document-text-outline' as const, label: t('profile.documents'), onPress: () => router.push('/profile/documents') },
        { icon: 'location-outline' as const, label: t('profile.saved_zones', { defaultValue: 'Zonas guardadas' }), onPress: () => router.push('/profile/saved-zones') },
        { icon: 'car-outline' as const, label: t('profile.vehicle', { defaultValue: 'Vehículo' }), onPress: () => router.push('/profile/vehicle') },
      ],
    },
    {
      title: t('profile.section_security', { defaultValue: 'Seguridad' }),
      items: [
        { icon: 'shield-checkmark-outline' as const, label: t('safety.title'), onPress: () => router.push('/profile/safety') },
        { icon: 'people-outline' as const, label: t('trusted_contacts.title', { defaultValue: 'Contactos de confianza' }), onPress: () => router.push('/profile/trusted-contacts') },
      ],
    },
    {
      title: t('profile.section_activity', { defaultValue: 'Actividad' }),
      items: [
        { icon: 'business-outline' as const, label: t('corporate.title', { defaultValue: 'Corporativo' }), onPress: () => router.push('/profile/corporate') },
        { icon: 'gift-outline' as const, label: t('profile.referral_title'), onPress: () => router.push('/profile/referral') },
      ],
    },
    {
      title: t('profile.section_more', { defaultValue: 'Más' }),
      items: [
        { icon: 'settings-outline' as const, label: t('profile.settings'), onPress: () => router.push('/profile/settings') },
        { icon: 'help-circle-outline' as const, label: t('profile.help'), onPress: () => router.push('/profile/help') },
        { icon: 'newspaper-outline' as const, label: t('profile.blog', { defaultValue: 'Blog' }), onPress: () => router.push('/profile/blog') },
        { icon: 'information-circle-outline' as const, label: t('profile.about_title', { defaultValue: 'Acerca de' }), onPress: () => router.push('/profile/about') },
      ],
    },
  ];

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <Text variant="h3" color="inverse" className="mb-6">
          {t('profile.title')}
        </Text>

        {/* ── Profile header card ── */}
        <Card variant="surface" padding="md" className="mb-4">
          <View className="flex-row items-center">
            <View
              className="w-16 h-16 rounded-full items-center justify-center mr-4"
              style={{ backgroundColor: colors.brand.orange }}
              accessible
              accessibilityLabel={`Avatar de ${user?.full_name ?? td('common.driver_label')}`}
            >
              <Text variant="h3" color="inverse">
                {user?.full_name?.charAt(0)?.toUpperCase() ?? 'C'}
              </Text>
            </View>
            <View className="flex-1">
              <Text variant="h4" color="inverse">{user?.full_name ?? td('common.driver_label')}</Text>
              <Text variant="bodySmall" color="secondary" className="mt-0.5">
                {user?.phone ?? '+53 5XXXXXXX'}
              </Text>
              {driverProfile?.status && (
                <View className="mt-2">
                  <StatusBadge
                    label={driverProfile.status === 'approved' ? td('common.active') : driverProfile.status}
                    variant={statusVariant}
                    icon={statusVariant === 'success' ? 'checkmark-circle' : statusVariant === 'warning' ? 'time-outline' : 'alert-circle'}
                  />
                </View>
              )}
            </View>
            <Pressable
              onPress={() => router.push('/profile/edit')}
              hitSlop={4}
              className="w-11 h-11 rounded-xl bg-[#1e1e1e] items-center justify-center"
              accessibilityRole="button"
              accessibilityLabel={t('profile.edit_profile')}
            >
              <Ionicons name="pencil" size={16} color={colors.neutral[400]} />
            </Pressable>
          </View>
        </Card>

        {/* ── Stats row ── */}
        {driverProfile && (
          <View className="flex-row gap-3 mb-6">
            <View className="flex-1">
              <StatCard
                icon="star"
                value={driverProfile.rating_avg != null && !isNaN(driverProfile.rating_avg)
                  ? driverProfile.rating_avg.toFixed(1) : '--'}
                label={td('earnings.rating')}
                iconColor="#FBBF24"
              />
            </View>
            <View className="flex-1">
              <StatCard
                icon="car-outline"
                value={String(driverProfile.total_rides ?? 0)}
                label={td('trips_history.title')}
              />
            </View>
          </View>
        )}

        {/* ── Menu sections ── */}
        {menuSections.map((section, sectionIdx) => (
          <AnimatedCard key={section.title} delay={sectionIdx * 100} className="mb-4">
            <Text variant="label" color="secondary" className="mb-2 ml-1">
              {section.title}
            </Text>
            <Card variant="surface" padding="none">
              {section.items.map((item, index) => (
                <Pressable
                  key={item.label}
                  className={`flex-row items-center px-4 min-h-[48px] ${index < section.items.length - 1 ? 'border-b border-white/6' : ''}`}
                  onPress={item.onPress}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                >
                  <View className="w-9 h-9 rounded-xl bg-[#1e1e1e] items-center justify-center mr-3">
                    <Ionicons name={item.icon} size={18} color={colors.brand.orange} />
                  </View>
                  <Text variant="body" color="inverse" className="flex-1">
                    {item.label}
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color={colors.neutral[600]} />
                </Pressable>
              ))}
            </Card>
          </AnimatedCard>
        ))}

        {/* ── Logout ── */}
        <Pressable
          className="flex-row items-center justify-center py-4 mt-2 mb-8 rounded-2xl bg-red-500/10 min-h-[48px]"
          onPress={handleLogout}
          disabled={loggingOut}
          accessibilityRole="button"
          accessibilityLabel={loggingOut ? t('auth.logging_out') : t('auth.logout')}
        >
          <Ionicons name="log-out-outline" size={20} color={colors.error.DEFAULT} />
          <Text variant="body" color="error" className="ml-2 font-semibold">
            {loggingOut ? t('auth.logging_out') : t('auth.logout')}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

export default function DriverProfileScreen() {
  return <NativeDriverProfileScreen />;
}
