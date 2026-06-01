// ============================================================
// Driver Profile tab — Cuban Modern redesign (post PR #234).
//
// Pattern: cubanLight/cubanDark palette, hero LinearGradient orange-glow,
// 3-stat row Inter_800ExtraBold tabular-nums, custom Cuban menu rows
// (no shared MenuRow for full visual control), red gradient logout
// with GLOW_DANGER + spring scale, stagger entrance.
//
// Lógica intacta: doLogout (signOut + driver setOffline + zustand resets),
// menuSections (4 sections, 13 items), navigation routes a 21 subscreens.
// ============================================================

import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Pressable,
  Alert,
  ScrollView,
  Animated,
  Easing,
  StyleSheet,
  useColorScheme,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { cubanLight, cubanDark, colors } from '@tricigo/theme';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import { authService, driverService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useNotificationStore } from '@/stores/notification.store';

const TABULAR: { fontVariant: ('tabular-nums')[] } = { fontVariant: ['tabular-nums'] };

type MenuItem = {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  tint: string;
};

type MenuSection = {
  title: string;
  items: MenuItem[];
};

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

  // Cuban palette
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;

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

  // ── Stagger entrance — 4 sections ──
  const fadeAnim = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;
  useEffect(() => {
    if (!isLoading) {
      Animated.stagger(
        80,
        fadeAnim.map((a) =>
          Animated.timing(a, {
            toValue: 1,
            duration: 380,
            useNativeDriver: true,
            easing: Easing.out(Easing.cubic),
          }),
        ),
      ).start();
    }
  }, [isLoading, fadeAnim]);

  const sectionStyle = (idx: number) => ({
    opacity: fadeAnim[idx]!,
    transform: [
      {
        translateY: fadeAnim[idx]!.interpolate({
          inputRange: [0, 1],
          outputRange: [12, 0],
        }),
      },
    ],
  });

  // ── Logout CTA spring scale ──
  const logoutScale = useRef(new Animated.Value(1)).current;
  const handleLogoutPressIn = () =>
    Animated.spring(logoutScale, { toValue: 0.97, useNativeDriver: true, speed: 50, bounciness: 4 }).start();
  const handleLogoutPressOut = () =>
    Animated.spring(logoutScale, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 6 }).start();

  if (isLoading) {
    return (
      <Screen scroll bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'}>
        <View style={{ flex: 1, backgroundColor: palette.bg.paper, paddingHorizontal: 16, paddingTop: 16 }}>
          <Text style={{ color: palette.ink.primary, fontSize: 28, fontWeight: '800', marginBottom: 20 }}>
            {t('profile.title')}
          </Text>
          <View style={{ height: 180, borderRadius: 24, backgroundColor: palette.bg.elev1, marginBottom: 16, ...CARD_SHADOW }} />
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

  // Status pill config
  const statusInfo: { color: string; label: string; icon: React.ComponentProps<typeof Ionicons>['name'] } | null =
    driverProfile?.status === 'approved'
      ? { color: '#22C55E', label: td('common.status_approved', { defaultValue: 'Aprobado' }), icon: 'checkmark-circle' }
      : driverProfile?.status === 'under_review'
        ? { color: '#F59E0B', label: td('common.status_under_review', { defaultValue: 'En revisión' }), icon: 'time-outline' }
        : driverProfile?.status === 'suspended'
          ? { color: '#EF4444', label: td('common.status_suspended', { defaultValue: 'Suspendido' }), icon: 'alert-circle' }
          : null;

  const menuSections: MenuSection[] = [
    {
      title: t('profile.section_account', { defaultValue: 'Cuenta' }),
      items: [
        { icon: 'person-outline', label: t('profile.edit_profile'), onPress: () => router.push('/profile/edit'), tint: colors.brand.orange },
        { icon: 'document-text-outline', label: t('profile.documents'), onPress: () => router.push('/profile/documents'), tint: '#F59E0B' },
        { icon: 'location-outline', label: t('profile.saved_zones', { defaultValue: 'Zonas guardadas' }), onPress: () => router.push('/profile/saved-zones'), tint: '#3B82F6' },
        { icon: 'car-outline', label: t('profile.vehicle', { defaultValue: 'Vehículo' }), onPress: () => router.push('/profile/vehicle'), tint: palette.ink.secondary },
      ],
    },
    {
      title: t('profile.section_security', { defaultValue: 'Seguridad' }),
      items: [
        { icon: 'shield-checkmark-outline', label: t('safety.title'), onPress: () => router.push('/profile/safety'), tint: '#22C55E' },
        { icon: 'people-outline', label: t('trusted_contacts.title', { defaultValue: 'Contactos de confianza' }), onPress: () => router.push('/profile/trusted-contacts'), tint: '#3B82F6' },
        { icon: 'phone-portrait-outline', label: t('devices.title', { defaultValue: 'Tus dispositivos' }), onPress: () => router.push('/profile/devices'), tint: '#8B5CF6' },
      ],
    },
    {
      title: t('profile.section_activity', { defaultValue: 'Actividad' }),
      items: [
        { icon: 'analytics-outline', label: td('performance.title', { defaultValue: 'Mi desempeño' }), onPress: () => router.push('/profile/performance'), tint: '#22C55E' },
        { icon: 'business-outline', label: t('corporate.title', { defaultValue: 'Corporativo' }), onPress: () => router.push('/profile/corporate'), tint: palette.ink.secondary },
        { icon: 'gift-outline', label: t('profile.referral_title'), onPress: () => router.push('/profile/referral'), tint: '#F59E0B' },
      ],
    },
    {
      title: t('profile.section_more', { defaultValue: 'Más' }),
      items: [
        { icon: 'settings-outline', label: t('profile.settings'), onPress: () => router.push('/profile/settings'), tint: palette.ink.secondary },
        { icon: 'help-circle-outline', label: t('profile.help'), onPress: () => router.push('/profile/help'), tint: palette.ink.secondary },
        { icon: 'newspaper-outline', label: t('profile.blog', { defaultValue: 'Blog' }), onPress: () => router.push('/profile/blog'), tint: '#3B82F6' },
        { icon: 'information-circle-outline', label: t('profile.about_title', { defaultValue: 'Acerca de' }), onPress: () => router.push('/profile/about'), tint: palette.ink.secondary },
      ],
    },
  ];

  // ── Cuban MenuRow (inline custom) ──
  const renderMenuRow = (item: MenuItem, isLast: boolean) => (
    <Pressable
      key={item.label}
      onPress={item.onPress}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 16,
          paddingHorizontal: 14,
          borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: palette.line,
        },
        pressed && { opacity: 0.65, backgroundColor: palette.bg.elev2 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={item.label}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 11,
          backgroundColor: `${item.tint}1A`,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: 14,
        }}
      >
        <Ionicons name={item.icon} size={18} color={item.tint} />
      </View>
      <Text numberOfLines={1} style={{ flex: 1, color: palette.ink.primary, fontSize: 15, fontWeight: '500' }}>
        {item.label}
      </Text>
      <Ionicons name="chevron-forward" size={18} color={palette.ink.subtle} />
    </Pressable>
  );

  // Stat helpers
  const rating = driverProfile?.rating_avg != null && !isNaN(driverProfile.rating_avg)
    ? driverProfile.rating_avg.toFixed(1)
    : '—';
  const acceptance = driverProfile?.acceptance_rate != null && !isNaN(driverProfile.acceptance_rate)
    ? `${Math.round(driverProfile.acceptance_rate)}%`
    : '—';
  const totalRides = String(driverProfile?.total_rides_completed ?? driverProfile?.total_rides ?? 0);

  return (
    <Screen scroll bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'}>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 }}>
          {/* Page title */}
          <Text
            style={{
              color: palette.ink.primary,
              fontSize: 28,
              fontWeight: '800',
              letterSpacing: -0.5,
              marginBottom: 20,
            }}
          >
            {t('profile.title')}
          </Text>

          {/* ── Hero card — avatar + name + status pill ── */}
          <Animated.View style={[sectionStyle(0), { borderRadius: 24, overflow: 'hidden', marginBottom: 18, ...HERO_SHADOW }]}>
            <LinearGradient
              colors={isDark ? ['#11172A', '#18203A'] : ['#FFFFFF', '#FFFBF5']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFillObject}
            />
            <LinearGradient
              colors={[palette.accent.orangeGlow, 'transparent']}
              start={{ x: 1, y: 0 }}
              end={{ x: 0.3, y: 0.7 }}
              style={{ position: 'absolute', top: 0, right: 0, width: 180, height: 180 }}
              pointerEvents="none"
            />
            <View style={{ padding: 24, flexDirection: 'row', alignItems: 'center' }}>
              {/* Avatar */}
              <View
                style={{
                  width: 76,
                  height: 76,
                  borderRadius: 38,
                  backgroundColor: colors.brand.orange,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 3,
                  borderColor: palette.accent.warm,
                  marginRight: 16,
                }}
                accessible
                accessibilityLabel={`Avatar de ${user?.full_name ?? td('common.driver_label')}`}
              >
                <Text style={{ color: '#FFFFFF', fontFamily: 'Inter_800ExtraBold', fontSize: 32 }}>
                  {user?.full_name?.charAt(0)?.toUpperCase() ?? 'C'}
                </Text>
              </View>
              {/* Name + phone + status */}
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    color: palette.ink.primary,
                    fontFamily: 'Inter_700Bold',
                    fontSize: 20,
                    letterSpacing: -0.4,
                  }}
                  numberOfLines={1}
                >
                  {user?.full_name ?? td('common.driver_label')}
                </Text>
                <Text style={{ color: palette.ink.secondary, fontSize: 13, marginTop: 3 }}>
                  {user?.phone ?? '+53 5XXXXXXX'}
                </Text>
                {statusInfo && (
                  <View
                    style={{
                      marginTop: 10,
                      alignSelf: 'flex-start',
                      flexDirection: 'row',
                      alignItems: 'center',
                      backgroundColor: `${statusInfo.color}22`,
                      borderRadius: 9999,
                      paddingHorizontal: 10,
                      paddingVertical: 4,
                    }}
                  >
                    <Ionicons name={statusInfo.icon} size={12} color={statusInfo.color} style={{ marginRight: 4 }} />
                    <Text
                      style={{
                        color: statusInfo.color,
                        fontSize: 11,
                        fontWeight: '700',
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                      }}
                    >
                      {statusInfo.label}
                    </Text>
                  </View>
                )}
              </View>
              {/* Edit button */}
              <Pressable
                onPress={() => router.push('/profile/edit')}
                style={({ pressed }) => [
                  {
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    backgroundColor: palette.bg.elev2,
                    alignItems: 'center',
                    justifyContent: 'center',
                  },
                  pressed && { transform: [{ scale: 0.94 }] },
                ]}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel={t('profile.edit_profile')}
              >
                <Ionicons name="pencil" size={16} color={palette.ink.secondary} />
              </Pressable>
            </View>
          </Animated.View>

          {/* ── 3-stat row ── */}
          {driverProfile && (
            <Animated.View style={[sectionStyle(1), { flexDirection: 'row', gap: 12, marginBottom: 24 }]}>
              {[
                { icon: 'star' as const, value: rating, label: td('earnings.rating'), tint: '#FBBF24' },
                { icon: 'checkmark-circle-outline' as const, value: acceptance, label: td('profile.acceptance_rate', { defaultValue: 'Aceptación' }), tint: '#22C55E' },
                { icon: 'car-outline' as const, value: totalRides, label: td('trips_history.title'), tint: colors.brand.orange },
              ].map((stat) => (
                <View
                  key={stat.label}
                  style={{
                    flex: 1,
                    backgroundColor: palette.bg.elev1,
                    borderRadius: 16,
                    padding: 14,
                    ...CARD_SHADOW,
                  }}
                >
                  <View
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 10,
                      backgroundColor: `${stat.tint}22`,
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: 10,
                    }}
                  >
                    <Ionicons name={stat.icon} size={16} color={stat.tint} />
                  </View>
                  <Text
                    style={{
                      color: palette.ink.primary,
                      fontFamily: 'Inter_800ExtraBold',
                      fontSize: 18,
                      letterSpacing: -0.3,
                      ...TABULAR,
                    }}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    {stat.value}
                  </Text>
                  <Text style={{ color: palette.ink.secondary, fontSize: 11, marginTop: 3 }} numberOfLines={1}>
                    {stat.label}
                  </Text>
                </View>
              ))}
            </Animated.View>
          )}

          {/* ── Menu sections ── */}
          <Animated.View style={sectionStyle(2)}>
            {menuSections.map((section) => (
              <View key={section.title} style={{ marginBottom: 24 }}>
                <Text
                  style={{
                    color: palette.ink.secondary,
                    fontSize: 11,
                    fontWeight: '700',
                    textTransform: 'uppercase',
                    letterSpacing: 1.2,
                    marginBottom: 10,
                    marginLeft: 4,
                  }}
                >
                  {section.title}
                </Text>
                <View
                  style={{
                    backgroundColor: palette.bg.elev1,
                    borderRadius: 16,
                    padding: 8,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: palette.line,
                    overflow: 'hidden',
                    ...CARD_SHADOW,
                    shadowOpacity: isDark ? 0.4 : 0.1,
                  }}
                >
                  {section.items.map((item, i) => renderMenuRow(item, i === section.items.length - 1))}
                </View>
              </View>
            ))}
          </Animated.View>

          {/* ── Logout — destructive CTA with red glow ── */}
          <Animated.View
            style={{
              opacity: fadeAnim[3]!,
              transform: [
                { translateY: fadeAnim[3]!.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
                { scale: logoutScale },
              ],
              marginTop: 8,
              ...GLOW_DANGER,
            }}
          >
            <Pressable
              onPress={handleLogout}
              onPressIn={handleLogoutPressIn}
              onPressOut={handleLogoutPressOut}
              disabled={loggingOut}
              style={{ borderRadius: 20, overflow: 'hidden', opacity: loggingOut ? 0.7 : 1 }}
              accessibilityRole="button"
              accessibilityLabel={t('auth.logout')}
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
                <Text
                  style={{
                    color: '#FFFFFF',
                    fontFamily: 'Inter_700Bold',
                    fontSize: 16,
                    marginLeft: 10,
                    letterSpacing: 0.3,
                  }}
                >
                  {loggingOut ? t('auth.logging_out') : t('auth.logout')}
                </Text>
              </LinearGradient>
            </Pressable>
          </Animated.View>
        </ScrollView>
      </View>
    </Screen>
  );
}

export default function DriverProfileScreen() {
  return <NativeDriverProfileScreen />;
}
