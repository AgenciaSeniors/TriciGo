import React, { useState, useCallback } from 'react';
import { View, Pressable, ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Avatar } from '@tricigo/ui/Avatar';
import { MenuRow } from '@tricigo/ui/MenuRow';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';
import { authService } from '@tricigo/api';
import { realEmail } from '@tricigo/utils';
import { router } from 'expo-router';
import type { UserLevel } from '@tricigo/types';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { Platform } from 'react-native';
import { colors } from '@tricigo/theme';
import { useThemeStore, setThemeMode } from '@/stores/theme.store';
import { useTokens } from '@/hooks/useTokens';
import { ProfileSection } from '@/components/profile/ProfileSection';
import { ProfileRow } from '@/components/profile/ProfileRow';
import { LinearGradient } from 'expo-linear-gradient';
import { Switch } from 'react-native';

// Loyalty tier badge styling per level (bronce -> diamante). Color is paired with
// an icon so the tier is never conveyed by color alone (a11y). Kept intentionally
// light; richer visuals (progress to next tier) can be layered later.
const TIER_BADGE: Record<
  UserLevel,
  { variant: React.ComponentProps<typeof StatusBadge>['variant']; icon: React.ComponentProps<typeof Ionicons>['name'] }
> = {
  bronce: { variant: 'warning', icon: 'medal-outline' },
  plata: { variant: 'neutral', icon: 'medal-outline' },
  oro: { variant: 'warning', icon: 'medal' },
  platino: { variant: 'info', icon: 'trophy' },
  diamante: { variant: 'success', icon: 'diamond' },
};

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
        { icon: 'person-outline' as const, label: t('profile.edit_profile'), href: '/profile/edit', iconBg: 'primary' as const },
        { icon: 'settings-outline' as const, label: t('profile.settings', { defaultValue: 'Configuración' }), href: '/profile/settings', iconBg: 'neutral' as const },
        { icon: 'location-outline' as const, label: t('profile.saved_locations'), href: '/profile/saved-locations', iconBg: 'info' as const },
      ],
    },
    {
      title: t('profile.section_safety', { defaultValue: 'Seguridad' }),
      items: [
        { icon: 'shield-checkmark-outline' as const, label: t('profile.safety', { defaultValue: 'Seguridad' }), href: '/profile/safety', iconBg: 'success' as const },
        { icon: 'people-outline' as const, label: t('profile.trusted_contacts', { defaultValue: 'Contactos de confianza' }), href: '/profile/trusted-contacts', iconBg: 'info' as const },
        { icon: 'phone-portrait-outline' as const, label: t('devices.title', { defaultValue: 'Tus dispositivos' }), href: '/profile/devices', iconBg: 'neutral' as const },
      ],
    },
    {
      title: t('profile.section_business', { defaultValue: 'Negocios' }),
      items: [
        { icon: 'business-outline' as const, label: t('profile.corporate', { defaultValue: 'Cuentas corporativas' }), href: '/profile/corporate', iconBg: 'neutral' as const },
      ],
    },
    {
      title: t('profile.section_more', { defaultValue: 'Más' }),
      items: [
        { icon: 'gift-outline' as const, label: t('profile.referral_title'), href: '/profile/referral', iconBg: 'warning' as const },
        { icon: 'chatbubble-outline' as const, label: t('profile.support', { defaultValue: 'Soporte' }), href: '/support', iconBg: 'primary' as const },
        { icon: 'help-circle-outline' as const, label: t('profile.help'), href: '/profile/help', iconBg: 'neutral' as const },
        { icon: 'information-circle-outline' as const, label: t('profile.about'), href: '/profile/about', iconBg: 'neutral' as const },
        { icon: 'newspaper-outline' as const, label: t('profile.blog', { defaultValue: 'Blog' }), href: '/profile/blog', iconBg: 'info' as const },
      ],
    },
  ];

  return (
    <Screen scroll bg="cuban" padded>
      <View className="pt-4">
        <Text variant="h4" className="mb-6">{t('profile.title', { defaultValue: 'Perfil' })}</Text>
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
            <Text variant="caption" color="secondary">{realEmail(user?.email) ?? user?.phone ?? ''}</Text>
          </View>
        </Card>

        {menuSections.map((section) => (
          <View key={section.title}>
            <Text variant="captionMono" color="tertiary" className="mt-5 mb-2">
              {section.title}
            </Text>
            {section.items.map((item, i) => (
              <MenuRow
                key={i}
                icon={item.icon}
                label={item.label}
                iconBg={item.iconBg}
                onPress={() => router.push(item.href as string)}
                showBorder={i < section.items.length - 1}
              />
            ))}
          </View>
        ))}

        <View className="mt-8 mb-4">
          <MenuRow
            icon="log-out-outline"
            label={loggingOut ? t('processing') : t('profile.logout', { defaultValue: 'Cerrar sesión' })}
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

function NativeProfileScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const reset = useAuthStore((s) => s.reset);
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const tokens = useTokens();
  const setUser = useAuthStore((s) => s.setUser);
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Cuban Modern shadows (mirror driver profile).
  const HERO_SHADOW = {
    shadowColor: '#FF4D00',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: isDark ? 0.28 : 0.16,
    shadowRadius: 24,
    elevation: 12,
  };
  const CARD_SHADOW = {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.4 : 0.06,
    shadowRadius: 8,
    elevation: 2,
  };
  const GLOW_DANGER = {
    shadowColor: '#EF4444',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 18,
    elevation: 10,
  };
  const tintFor = (bg?: string): string => {
    switch (bg) {
      case 'primary': return '#FF4D00';
      case 'info': return '#3B82F6';
      case 'success': return '#22C55E';
      case 'warning': return '#F59E0B';
      case 'error': return '#EF4444';
      default: return tokens.ink.secondary;
    }
  };

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
      <Screen scroll bg="cuban" padded>
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
        { icon: 'person-outline' as const, label: t('profile.edit_profile'), onPress: () => router.push('/profile/edit'), iconBg: 'primary' as const },
        { icon: 'location-outline' as const, label: t('profile.saved_locations'), onPress: () => router.push('/profile/saved-locations'), iconBg: 'info' as const },
      ],
    },
    {
      title: t('profile.section_safety', { defaultValue: 'Seguridad' }),
      items: [
        { icon: 'people-outline' as const, label: t('trusted_contacts.title'), onPress: () => router.push('/profile/trusted-contacts'), iconBg: 'info' as const },
        { icon: 'shield-checkmark-outline' as const, label: t('safety.title'), onPress: () => router.push('/profile/safety'), iconBg: 'success' as const },
        { icon: 'phone-portrait-outline' as const, label: t('devices.title', { defaultValue: 'Tus dispositivos' }), onPress: () => router.push('/profile/devices'), iconBg: 'neutral' as const },
      ],
    },
    {
      title: t('profile.section_activity', { defaultValue: 'Actividad' }),
      items: [
        // PASS2: the recurring-rides screen existed but no menu linked to it
        // (orphan since the feature shipped) — the web hub already lists it.
        { icon: 'repeat-outline' as const, label: t('recurring.title', { ns: 'rider', defaultValue: 'Viajes recurrentes' }), onPress: () => router.push('/profile/recurring-rides'), iconBg: 'primary' as const },
        { icon: 'business-outline' as const, label: t('profile.corporate', { defaultValue: 'Corporativo' }), onPress: () => router.push('/profile/corporate'), iconBg: 'neutral' as const },
      ],
    },
    {
      title: t('profile.section_more', { defaultValue: 'Más' }),
      items: [
        { icon: 'settings-outline' as const, label: t('profile.settings', { defaultValue: 'Configuración' }), onPress: () => router.push('/profile/settings'), iconBg: 'neutral' as const },
        { icon: 'gift-outline' as const, label: t('profile.referral_title'), onPress: () => router.push('/profile/referral'), iconBg: 'warning' as const },
        { icon: 'help-circle-outline' as const, label: t('profile.help'), onPress: () => router.push('/profile/help'), iconBg: 'neutral' as const },
        { icon: 'newspaper-outline' as const, label: t('profile.blog_title', { defaultValue: 'Blog' }), onPress: () => router.push('/profile/blog'), iconBg: 'info' as const },
        { icon: 'information-circle-outline' as const, label: t('profile.about'), onPress: () => router.push('/profile/about'), iconBg: 'neutral' as const },
      ],
    },
  ];

  return (
    <Screen bg="cuban" padded={false}>
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
        <View
          className="pt-4"
          style={{ backgroundColor: tokens.bg.paper, flex: 1 }}
        >
          <View className="flex-row items-center justify-between mb-4">
            <Text style={{ color: tokens.ink.primary, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 }}>
              {t('profile.title')}
            </Text>
          </View>

          {/* Identity hero — 3-layer (gradient base + orange glow), driver
              parity, no stats row. Avatar keeps its photo + gradient ring. */}
          <AnimatedCard delay={0}>
            <View style={{ borderRadius: 24, marginBottom: 12, ...HERO_SHADOW }}>
              <View style={{ borderRadius: 24, overflow: 'hidden' }}>
                <LinearGradient
                  colors={isDark ? ['#11172A', '#18203A'] : ['#FFFFFF', '#FFFBF5']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFillObject}
                />
                <LinearGradient
                  colors={[tokens.accent.orangeGlow, 'transparent']}
                  start={{ x: 1, y: 0 }}
                  end={{ x: 0.3, y: 0.7 }}
                  style={{ position: 'absolute', top: 0, right: 0, width: 180, height: 180 }}
                  pointerEvents="none"
                />
                <View style={{ padding: 20, flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ marginRight: 16 }}>
                    <LinearGradient
                      colors={[colors.primary[500], colors.primary[300]]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={{ borderRadius: 35.5, padding: 2.5 }}
                    >
                      <View style={{ borderRadius: 33, overflow: 'hidden' }}>
                        <Avatar
                          uri={user?.avatar_url}
                          name={user?.full_name ?? 'U'}
                          size={62}
                          onPress={() => router.push('/profile/edit')}
                          showEditBadge
                        />
                      </View>
                    </LinearGradient>
                  </View>
                  <View style={{ flex: 1 }}>
                    <View className="flex-row items-center gap-2">
                      <Text
                        style={{ flexShrink: 1, color: tokens.ink.primary, fontFamily: 'Montserrat_700Bold', fontSize: 20, letterSpacing: -0.4 }}
                        numberOfLines={1}
                      >
                        {user?.full_name ?? 'Usuario'}
                      </Text>
                      {user?.level && (
                        <StatusBadge
                          label={t(`profile.level_${user.level}`)}
                          variant={(TIER_BADGE[user.level] ?? TIER_BADGE.bronce).variant}
                          icon={(TIER_BADGE[user.level] ?? TIER_BADGE.bronce).icon}
                        />
                      )}
                    </View>
                    <Text style={{ color: tokens.ink.secondary, fontSize: 13, marginTop: 3 }}>
                      {user?.phone ?? '+53 5XXXXXXX'}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => router.push('/profile/edit')}
                    style={({ pressed }) => [
                      {
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        backgroundColor: tokens.bg.elev2,
                        alignItems: 'center',
                        justifyContent: 'center',
                      },
                      pressed && { transform: [{ scale: 0.94 }] },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={t('profile.edit_profile')}
                  >
                    <Ionicons name="pencil" size={16} color={tokens.ink.secondary} />
                  </Pressable>
                </View>
              </View>
            </View>
          </AnimatedCard>

          {/* Quick dark mode toggle — own Cuban card, reachable in 1 tap. */}
          <AnimatedCard delay={60}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: tokens.bg.elev1,
                borderRadius: 16,
                paddingVertical: 12,
                paddingHorizontal: 16,
                marginBottom: 8,
                ...CARD_SHADOW,
              }}
            >
              <View className="flex-row items-center gap-2">
                <Ionicons name={isDark ? 'moon' : 'sunny-outline'} size={18} color={tokens.accent.orange} />
                <Text variant="bodySmall" style={{ color: tokens.ink.primary }}>
                  {t('profile.dark_mode', { defaultValue: 'Modo oscuro' })}
                </Text>
              </View>
              <Switch
                value={isDark}
                onValueChange={(v) => setThemeMode(v ? 'dark' : 'light')}
                trackColor={{ false: tokens.line, true: tokens.accent.orange }}
                thumbColor="#FFFFFF"
                ios_backgroundColor={tokens.line}
              />
            </View>
          </AnimatedCard>

          {/* Menu sections — Cuban cards with tinted icon-box rows. */}
          {menuSections.map((section) => (
            <ProfileSection key={section.title} title={section.title}>
              {section.items.map((item, idx) => (
                <ProfileRow
                  key={item.label}
                  icon={item.icon}
                  tint={tintFor(item.iconBg)}
                  label={item.label}
                  onPress={item.onPress}
                  isLast={idx === section.items.length - 1}
                />
              ))}
            </ProfileSection>
          ))}

          {/* Logout — red gradient glow CTA (driver parity). */}
          <View style={{ marginTop: 8, marginBottom: 24, ...GLOW_DANGER }}>
            <Pressable
              onPress={handleLogout}
              disabled={loggingOut}
              accessibilityRole="button"
              accessibilityLabel={t('auth.logout')}
              style={({ pressed }) => [
                { borderRadius: 20, overflow: 'hidden', opacity: loggingOut ? 0.7 : 1 },
                pressed && { transform: [{ scale: 0.97 }], opacity: 0.95 },
              ]}
            >
              <LinearGradient
                colors={['#EF4444', '#F87171']}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingVertical: 16,
                  paddingHorizontal: 24,
                  minHeight: 56,
                }}
              >
                <Ionicons name="log-out-outline" size={22} color="#FFFFFF" />
                <Text style={{ color: '#FFFFFF', fontFamily: 'Montserrat_700Bold', fontSize: 16, marginLeft: 10, letterSpacing: 0.3 }}>
                  {loggingOut ? t('auth.logging_out') : t('auth.logout')}
                </Text>
              </LinearGradient>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

export default function ProfileScreen() {
  if (Platform.OS === 'web') return <WebProfileScreen />;
  return <NativeProfileScreen />;
}
