import React, { useState } from 'react';
import { View, Pressable, Alert, Platform, ScrollView } from 'react-native';
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
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <Text variant="h3" color="inverse" className="mb-6">
          {t('profile.title')}
        </Text>

        {/* ── Profile header card ── */}
        <Card variant="surface" padding="md" className="mb-4" forceDark>
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
                forceDark
              />
            </View>
            <View className="flex-1">
              <StatCard
                icon="car-outline"
                value={String(driverProfile.total_rides ?? 0)}
                label={td('trips_history.title')}
                forceDark
              />
            </View>
          </View>
        )}

        {/* ── Menu sections ── */}
        <StaggeredList staggerDelay={60}>
          {menuSections.map((section) => (
            <View key={section.title} className="mb-4">
              <Text variant="caption" style={{ color: colors.neutral[500] }} className="mb-2 ml-1 uppercase tracking-wider font-semibold">
                {section.title}
              </Text>
              <Card variant="surface" padding="none" className="px-3" forceDark>
                {section.items.map((item, index) => (
                  <MenuRow
                    key={item.label}
                    icon={item.icon}
                    label={item.label}
                    iconBg={item.iconBg}
                    onPress={item.onPress}
                    showBorder={index < section.items.length - 1}
                    forceDark
                  />
                ))}
              </Card>
            </View>
          ))}
        </StaggeredList>

        {/* ── Logout ── */}
        <View className="mt-2 mb-8 px-3">
          <MenuRow
            icon="log-out-outline"
            label={loggingOut ? t('auth.logging_out') : t('auth.logout')}
            onPress={handleLogout}
            destructive
            showChevron={false}
            showBorder={false}
            disabled={loggingOut}
            forceDark
          />
        </View>
      </View>
    </Screen>
  );
}

// TEMP: Static web version for Play Store screenshots (all inline styles to bypass NativeWind web issues)
function WebDriverProfileScreen() {
  const font = { fontFamily: 'Montserrat, system-ui, sans-serif' };
  const CARD_BG = '#1a1a2e';
  const BORDER = '#2a2a3e';

  const menuSections = [
    {
      title: 'Cuenta',
      items: [
        { icon: 'person-outline' as const, label: 'Editar perfil', color: '#F97316' },
        { icon: 'document-text-outline' as const, label: 'Documentos', color: '#FBBF24' },
        { icon: 'location-outline' as const, label: 'Zonas guardadas', color: '#3B82F6' },
        { icon: 'car-outline' as const, label: 'Vehículo', color: '#9ca3af' },
      ],
    },
    {
      title: 'Seguridad',
      items: [
        { icon: 'shield-checkmark-outline' as const, label: 'Centro de Seguridad', color: '#22C55E' },
        { icon: 'people-outline' as const, label: 'Contactos de Confianza', color: '#3B82F6' },
      ],
    },
    {
      title: 'Actividad',
      items: [
        { icon: 'business-outline' as const, label: 'Corporativo', color: '#9ca3af' },
        { icon: 'gift-outline' as const, label: 'Referidos', color: '#FBBF24' },
      ],
    },
    {
      title: 'Más',
      items: [
        { icon: 'settings-outline' as const, label: 'Configuración', color: '#9ca3af' },
        { icon: 'help-circle-outline' as const, label: 'Ayuda', color: '#9ca3af' },
        { icon: 'newspaper-outline' as const, label: 'Blog', color: '#3B82F6' },
        { icon: 'information-circle-outline' as const, label: 'Acerca de TriciGo', color: '#9ca3af' },
      ],
    },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: '#111111' }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
        <View style={{ paddingTop: 16 }}>
          <Text style={{ fontSize: 24, fontWeight: '700', color: '#fff', marginBottom: 20, ...font }}>Perfil</Text>

          {/* Profile header card */}
          <View style={{ backgroundColor: CARD_BG, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: BORDER, flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: '#F97316', alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
              <Text style={{ fontSize: 22, fontWeight: '700', color: '#fff', ...font }}>E</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 17, fontWeight: '600', color: '#fff', ...font }}>Eduardo Admin</Text>
              <Text style={{ fontSize: 13, color: '#9ca3af', marginTop: 2, ...font }}>+5356621636</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
                <View style={{ backgroundColor: 'rgba(34,197,94,0.15)', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Ionicons name="checkmark-circle" size={12} color="#4ade80" />
                  <Text style={{ fontSize: 11, color: '#4ade80', fontWeight: '600', ...font }}>Activo</Text>
                </View>
              </View>
            </View>
            <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: '#1e1e1e', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="pencil" size={14} color="#9ca3af" />
            </View>
          </View>

          {/* Stats row */}
          <View style={{ flexDirection: 'row', gap: 12, marginBottom: 20 }}>
            <View style={{ flex: 1, backgroundColor: CARD_BG, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: BORDER, alignItems: 'center' }}>
              <Ionicons name="star" size={20} color="#FBBF24" />
              <Text style={{ fontSize: 22, fontWeight: '700', color: '#fff', marginTop: 4, ...font }}>5.0</Text>
              <Text style={{ fontSize: 11, color: '#9ca3af', ...font }}>Tu calificación</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: CARD_BG, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: BORDER, alignItems: 'center' }}>
              <Ionicons name="car-outline" size={20} color="#F97316" />
              <Text style={{ fontSize: 22, fontWeight: '700', color: '#fff', marginTop: 4, ...font }}>0</Text>
              <Text style={{ fontSize: 11, color: '#9ca3af', ...font }}>Mis viajes</Text>
            </View>
          </View>

          {/* Menu sections */}
          {menuSections.map((section) => (
            <View key={section.title} style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 11, color: '#6b7280', fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8, marginLeft: 4, ...font }}>{section.title}</Text>
              <View style={{ backgroundColor: CARD_BG, borderRadius: 14, borderWidth: 1, borderColor: BORDER, paddingHorizontal: 12 }}>
                {section.items.map((item, index) => (
                  <Pressable key={item.label} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: index < section.items.length - 1 ? 1 : 0, borderBottomColor: BORDER }}>
                    <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: `${item.color}15`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                      <Ionicons name={item.icon} size={18} color={item.color} />
                    </View>
                    <Text style={{ flex: 1, fontSize: 14, color: '#f5f5f5', ...font }}>{item.label}</Text>
                    <Ionicons name="chevron-forward" size={16} color="#6b7280" />
                  </Pressable>
                ))}
              </View>
            </View>
          ))}

          {/* Logout */}
          <Pressable style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, marginTop: 4, marginBottom: 16 }}>
            <Ionicons name="log-out-outline" size={20} color="#EF4444" style={{ marginRight: 12 }} />
            <Text style={{ fontSize: 14, color: '#EF4444', fontWeight: '500', ...font }}>Cerrar sesión</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

export default function DriverProfileScreen() {
  if (Platform.OS === 'web') return <WebDriverProfileScreen />;
  return <NativeDriverProfileScreen />;
}
