import React, { useState } from 'react';
import { View, Pressable, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { MenuRow } from '@tricigo/ui/MenuRow';
import { StatCard } from '@tricigo/ui/StatCard';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { AnimatedCard, StaggeredList } from '@tricigo/ui/AnimatedCard';
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
      <Screen scroll bg="lightPrimary" statusBarStyle="dark-content" padded>
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
        { icon: 'person-outline' as const, label: t('profile.edit_profile'), onPress: () => router.push('/profile/edit'), iconBg: 'primary' as const },
        { icon: 'document-text-outline' as const, label: t('profile.documents'), onPress: () => router.push('/profile/documents'), iconBg: 'warning' as const },
        { icon: 'location-outline' as const, label: t('profile.saved_zones', { defaultValue: 'Zonas guardadas' }), onPress: () => router.push('/profile/saved-zones'), iconBg: 'info' as const },
        { icon: 'car-outline' as const, label: t('profile.vehicle', { defaultValue: 'Vehículo' }), onPress: () => router.push('/profile/vehicle'), iconBg: 'neutral' as const },
      ],
    },
    {
      title: t('profile.section_security', { defaultValue: 'Seguridad' }),
      items: [
        { icon: 'shield-checkmark-outline' as const, label: t('safety.title'), onPress: () => router.push('/profile/safety'), iconBg: 'success' as const },
        { icon: 'people-outline' as const, label: t('trusted_contacts.title', { defaultValue: 'Contactos de confianza' }), onPress: () => router.push('/profile/trusted-contacts'), iconBg: 'info' as const },
      ],
    },
    {
      title: t('profile.section_activity', { defaultValue: 'Actividad' }),
      items: [
        { icon: 'business-outline' as const, label: t('corporate.title', { defaultValue: 'Corporativo' }), onPress: () => router.push('/profile/corporate'), iconBg: 'neutral' as const },
        { icon: 'gift-outline' as const, label: t('profile.referral_title'), onPress: () => router.push('/profile/referral'), iconBg: 'warning' as const },
      ],
    },
    {
      title: t('profile.section_more', { defaultValue: 'Más' }),
      items: [
        { icon: 'settings-outline' as const, label: t('profile.settings'), onPress: () => router.push('/profile/settings'), iconBg: 'neutral' as const },
        { icon: 'help-circle-outline' as const, label: t('profile.help'), onPress: () => router.push('/profile/help'), iconBg: 'neutral' as const },
        { icon: 'newspaper-outline' as const, label: t('profile.blog', { defaultValue: 'Blog' }), onPress: () => router.push('/profile/blog'), iconBg: 'info' as const },
        { icon: 'information-circle-outline' as const, label: t('profile.about_title', { defaultValue: 'Acerca de' }), onPress: () => router.push('/profile/about'), iconBg: 'neutral' as const },
      ],
    },
  ];

  return (
    <Screen scroll bg="lightPrimary" statusBarStyle="dark-content" padded>
      <View className="pt-4">
        <Text variant="h3" color="primary" className="mb-6">
          {t('profile.title')}
        </Text>

        {/* ── Profile header card ── */}
        <Card variant="surface" padding="md" className="mb-4 bg-white" style={{ borderWidth: 1, borderColor: '#E2E8F0', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 2 }}>
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
              <Text variant="h4" style={{ color: '#0F172A' }}>{user?.full_name ?? td('common.driver_label')}</Text>
              <Text variant="bodySmall" style={{ color: '#64748B' }} className="mt-0.5">
                {user?.phone ?? '+53 5XXXXXXX'}
              </Text>
              {driverProfile?.status && (
                <View className="mt-2">
                  <StatusBadge
                    label={td(`common.status_${driverProfile.status}`, { defaultValue: driverProfile.status })}
                    variant={statusVariant}
                    icon={statusVariant === 'success' ? 'checkmark-circle' : statusVariant === 'warning' ? 'time-outline' : 'alert-circle'}
                  />
                </View>
              )}
            </View>
            <Pressable
              onPress={() => router.push('/profile/edit')}
              hitSlop={4}
              className="w-11 h-11 rounded-xl items-center justify-center"
              style={{ backgroundColor: '#F1F5F9' }}
              accessibilityRole="button"
              accessibilityLabel={t('profile.edit_profile')}
            >
              <Ionicons name="pencil" size={16} color="#64748B" />
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
        <StaggeredList staggerDelay={60}>
          {menuSections.map((section) => (
            <View key={section.title} className="mb-4">
              <Text variant="caption" style={{ color: '#64748B' }} className="mb-2 ml-1 uppercase tracking-wider font-semibold">
                {section.title}
              </Text>
              <Card variant="surface" padding="none" className="px-3 bg-white" style={{ borderWidth: 1, borderColor: '#E2E8F0' }}>
                {section.items.map((item, index) => (
                  <MenuRow
                    key={item.label}
                    icon={item.icon}
                    label={item.label}
                    iconBg={item.iconBg}
                    onPress={item.onPress}
                    showBorder={index < section.items.length - 1}
                  />
                ))}
              </Card>
            </View>
          ))}
        </StaggeredList>

        {/* ── Logout ── */}
        <View className="mt-2 mb-8 px-3 rounded-xl" style={{ backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA' }}>
          <MenuRow
            icon="log-out-outline"
            label={loggingOut ? t('auth.logging_out') : t('auth.logout')}
            onPress={handleLogout}
            destructive
            showChevron={false}
            showBorder={false}
            disabled={loggingOut}
          />
        </View>
      </View>
    </Screen>
  );
}

export default function DriverProfileScreen() {
  return <NativeDriverProfileScreen />;
}
