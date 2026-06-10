import React from 'react';
import { Platform } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { useDriverRideStore } from '@/stores/ride.store';
import { NotificationPermissionSheet } from '@/components/NotificationPermissionSheet';

export default function TabLayout() {
  const { t } = useTranslation('driver');
  const insets = useSafeAreaInsets();
  // BUG-235: hide bottom tabs during an active trip so the driver focuses
  // on the map + trip controls. Tabs (Earnings, Billetera, Mis viajes,
  // Perfil) aren't relevant while driving and steal ~80pt of screen.
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const inActiveTrip = !!activeTrip && activeTrip.status !== 'completed' && activeTrip.status !== 'canceled';

  return (
    <>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.brand.orange,
          tabBarInactiveTintColor: colors.neutral[500],
          tabBarStyle: inActiveTrip
            ? { display: 'none' }
            : {
                backgroundColor: '#141418',
                borderTopColor: 'rgba(255,255,255,0.06)',
                borderTopWidth: 1,
                paddingBottom: 8 + insets.bottom,
                paddingTop: 8,
                height: 64 + insets.bottom,
                ...(Platform.OS === 'web'
                  ? { backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', backgroundColor: 'rgba(20,20,24,0.92)' } as any
                  : {}),
              },
          tabBarLabelStyle: {
            fontFamily: 'Inter',
            fontSize: 11,
            fontWeight: '600',
            letterSpacing: 0.2,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: t('common.home_tab', { defaultValue: 'Inicio' }),
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="navigate" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="earnings"
          options={{
            title: t('earnings.title'),
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="cash" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="wallet"
          options={{
            title: t('wallet.title', { defaultValue: 'Billetera' }),
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="wallet" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="trips"
          options={{
            title: t('trips_history.title'),
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="list" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: t('common.profile_tab', { defaultValue: 'Perfil' }),
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="person" size={size} color={color} />
            ),
          }}
        />
      </Tabs>
      <NotificationPermissionSheet />
    </>
  );
}
