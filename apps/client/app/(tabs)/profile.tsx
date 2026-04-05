import React, { useState, useCallback } from 'react';
import { View, Pressable, ScrollView, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Avatar } from '@tricigo/ui/Avatar';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';
import { authService } from '@tricigo/api';
import { router } from 'expo-router';
import type { UserLevel } from '@tricigo/types';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import { AnimatedCard, StaggeredList } from '@tricigo/ui/AnimatedCard';
import { Platform } from 'react-native';
import { colors, darkColors } from '@tricigo/theme';
import { useThemeStore } from '@/stores/theme.store';
import { LinearGradient } from 'expo-linear-gradient';

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

  const menuSections = [
    {
      title: t('profile.section_account', { defaultValue: 'Cuenta' }),
      items: [
        { icon: 'person-outline' as const, label: t('profile.edit_profile'), href: '/profile/edit' },
        { icon: 'settings-outline' as const, label: t('profile.settings', { defaultValue: 'Configuración' }), href: '/profile/settings' },
        { icon: 'location-outline' as const, label: t('profile.saved_locations'), href: '/profile/saved-locations' },
      ],
    },
    {
      title: t('profile.section_safety', { defaultValue: 'Seguridad' }),
      items: [
        { icon: 'shield-checkmark-outline' as const, label: t('profile.safety', { defaultValue: 'Seguridad' }), href: '/profile/safety' },
        { icon: 'people-outline' as const, label: t('profile.trusted_contacts', { defaultValue: 'Contactos de confianza' }), href: '/profile/trusted-contacts' },
        { icon: 'car-outline' as const, label: t('profile.ride_preferences', { defaultValue: 'Preferencias de viaje' }), href: '/profile/ride-preferences' },
      ],
    },
    {
      title: t('profile.section_business', { defaultValue: 'Negocios' }),
      items: [
        { icon: 'business-outline' as const, label: t('profile.corporate', { defaultValue: 'Cuentas corporativas' }), href: '/profile/corporate' },
        { icon: 'repeat-outline' as const, label: t('profile.recurring_rides', { defaultValue: 'Viajes recurrentes' }), href: '/profile/recurring-rides' },
      ],
    },
    {
      title: t('profile.section_more', { defaultValue: 'Más' }),
      items: [
        { icon: 'gift-outline' as const, label: t('profile.referral_title'), href: '/profile/referral' },
        { icon: 'chatbubble-outline' as const, label: t('profile.support', { defaultValue: 'Soporte' }), href: '/support' },
        { icon: 'help-circle-outline' as const, label: t('profile.help'), href: '/profile/help' },
        { icon: 'information-circle-outline' as const, label: t('profile.about'), href: '/profile/about' },
        { icon: 'newspaper-outline' as const, label: t('profile.blog', { defaultValue: 'Blog' }), href: '/profile/blog' },
      ],
    },
  ];

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <Text variant="h3" className="mb-6">{t('profile.title', { defaultValue: 'Perfil' })}</Text>
        <Card variant="filled" padding="md" className="mb-6 flex-row items-center">
          <View className="mr-4">
            <View style={{
              background: 'linear-gradient(135deg, #FF4D00, #FF8A5C)',
              borderRadius: 32, padding: 3,
            } as any}>
              <View style={{ borderRadius: 29, overflow: 'hidden' }}>
                <Avatar
                  uri={user?.avatar_url}
                  name={user?.full_name ?? 'U'}
                  size={56}
                  onPress={() => router.push('/profile/edit')}
                  showEditBadge
                />
              </View>
            </View>
          </View>
          <View className="flex-1">
            <Text variant="h4">{user?.full_name ?? t('common.no_name', { defaultValue: 'Sin nombre' })}</Text>
            <Text variant="caption" color="secondary">{user?.email ?? ''}</Text>
          </View>
        </Card>

        {menuSections.map((section) => (
          <View key={section.title}>
            <Text variant="caption" color="tertiary" className="mt-5 mb-2 uppercase tracking-wider font-semibold">
              {section.title}
            </Text>
            {section.items.map((item, i) => (
              <Pressable key={i} className="flex-row items-center py-4 border-b border-neutral-100 dark:border-neutral-800"
                onPress={() => router.push(item.href as string)}>
                <Ionicons name={item.icon} size={22} color={colors.neutral[500]} />
                <Text variant="body" className="flex-1 ml-4">{item.label}</Text>
                <Ionicons name="chevron-forward" size={18} color={colors.neutral[400]} />
              </Pressable>
            ))}
          </View>
        ))}

        <Pressable className="flex-row items-center py-4 mt-6" onPress={handleLogout} disabled={loggingOut}>
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
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const setUser = useAuthStore((s) => s.setUser);
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const freshUser = await authService.getCurrentUser();
      if (freshUser) setUser(freshUser);
    } catch { /* best effort */ }
    setRefreshing(false);
  }, [setUser]);

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

  const menuSections = [
    {
      title: t('profile.section_account', { defaultValue: 'Cuenta' }),
      items: [
        { icon: 'person-outline' as const, label: t('profile.edit_profile'), onPress: () => router.push('/profile/edit') },
        { icon: 'location-outline' as const, label: t('profile.saved_locations'), onPress: () => router.push('/profile/saved-locations') },
        { icon: 'options-outline' as const, label: t('profile.ride_preferences', { defaultValue: 'Preferencias de viaje' }), onPress: () => router.push('/profile/ride-preferences') },
      ],
    },
    {
      title: t('profile.section_safety', { defaultValue: 'Seguridad' }),
      items: [
        { icon: 'call-outline' as const, label: t('profile.emergency_contact'), onPress: () => router.push('/profile/emergency-contact') },
        { icon: 'people-outline' as const, label: t('trusted_contacts.title'), onPress: () => router.push('/profile/trusted-contacts') },
        { icon: 'shield-checkmark-outline' as const, label: t('safety.title'), onPress: () => router.push('/profile/safety') },
      ],
    },
    {
      title: t('profile.section_activity', { defaultValue: 'Actividad' }),
      items: [
        { icon: 'repeat-outline' as const, label: t('recurring_rides'), onPress: () => router.push('/profile/recurring-rides') },
        { icon: 'business-outline' as const, label: t('profile.corporate', { defaultValue: 'Corporativo' }), onPress: () => router.push('/profile/corporate') },
      ],
    },
    {
      title: t('profile.section_more', { defaultValue: 'Más' }),
      items: [
        { icon: 'settings-outline' as const, label: t('profile.settings', { defaultValue: 'Configuración' }), onPress: () => router.push('/profile/settings') },
        { icon: 'gift-outline' as const, label: t('profile.referral_title'), onPress: () => router.push('/profile/referral') },
        { icon: 'help-circle-outline' as const, label: t('profile.help'), onPress: () => router.push('/profile/help') },
        { icon: 'newspaper-outline' as const, label: t('profile.blog_title', { defaultValue: 'Blog' }), onPress: () => router.push('/profile/blog') },
        { icon: 'information-circle-outline' as const, label: t('profile.about'), onPress: () => router.push('/profile/about') },
      ],
    },
  ];

  return (
    <Screen bg="white" padded={false}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.brand.orange}
            colors={[colors.brand.orange]}
          />
        }
      >
        <View className="pt-4">
          <Text variant="h3" className="mb-6">
            {t('profile.title')}
          </Text>

          {/* User info card */}
          <AnimatedCard delay={0}>
            <Card variant="filled" padding="md" className="mb-6 flex-row items-center">
              <View className="mr-4">
                <LinearGradient
                  colors={['#FF4D00', '#FF8A5C']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={{ borderRadius: 32, padding: 3 }}
                >
                  <View style={{ borderRadius: 29, overflow: 'hidden' }}>
                    <Avatar
                      uri={user?.avatar_url}
                      name={user?.full_name ?? 'U'}
                      size={56}
                      onPress={() => router.push('/profile/edit')}
                      showEditBadge
                    />
                  </View>
                </LinearGradient>
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
          </AnimatedCard>

          {/* Menu sections */}
          <StaggeredList staggerDelay={40}>
            {menuSections.map((section) => (
              <View key={section.title}>
                <Text variant="caption" color="tertiary" className="mt-5 mb-2 uppercase tracking-wider font-semibold">
                  {section.title}
                </Text>
                {section.items.map((item) => (
                  <Pressable
                    key={item.label}
                    className="flex-row items-center py-4 border-b border-neutral-100 dark:border-neutral-800"
                    onPress={item.onPress}
                  >
                    <Ionicons name={item.icon} size={22} color={isDark ? darkColors.text.secondary : colors.neutral[600]} />
                    <Text variant="body" className="ml-3 flex-1">
                      {item.label}
                    </Text>
                    <Ionicons name="chevron-forward" size={20} color={isDark ? darkColors.text.tertiary : colors.neutral[400]} />
                  </Pressable>
                ))}
              </View>
            ))}
          </StaggeredList>

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
      </ScrollView>
    </Screen>
  );
}

export default function ProfileScreen() {
  if (Platform.OS === 'web') return <WebProfileScreen />;
  return <NativeProfileScreen />;
}
