import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, darkColors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import { useThemeStore } from '@/stores/theme.store';
import { useNotificationStore } from '@/stores/notification.store';
import { triggerSelection } from '@tricigo/utils';

export default function TabLayout() {
  const { t } = useTranslation('rider');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand.orange,
        tabBarInactiveTintColor: isDark ? darkColors.text.secondary : colors.neutral[500],
        tabBarStyle: {
          backgroundColor: isDark ? darkColors.background.primary : colors.background.primary,
          borderTopColor: isDark ? darkColors.border.default : colors.neutral[200],
          paddingBottom: 8 + insets.bottom,
          paddingTop: 8,
          height: 60 + insets.bottom,
        },
        tabBarLabelStyle: {
          fontFamily: 'Montserrat',
          fontSize: 11,
          fontWeight: '600',
        },
        animation: 'fade',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.home'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home" size={size} color={color} />
          ),
          tabBarBadge: unreadCount > 0 ? unreadCount : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.brand.orange, fontSize: 10, minWidth: 18, height: 18 },
        }}
        listeners={{ tabPress: () => triggerSelection() }}
      />
      <Tabs.Screen
        name="rides"
        options={{
          title: t('rides_history.title'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="car" size={size} color={color} />
          ),
        }}
        listeners={{ tabPress: () => triggerSelection() }}
      />
      <Tabs.Screen
        name="wallet"
        options={{
          title: t('payment.tricicoin'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="wallet" size={size} color={color} />
          ),
        }}
        listeners={{ tabPress: () => triggerSelection() }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: t('tabs.profile'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person" size={size} color={color} />
          ),
        }}
        listeners={{ tabPress: () => triggerSelection() }}
      />
    </Tabs>
  );
}
