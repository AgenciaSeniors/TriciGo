import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';

export default function DriverProfileScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);

  const menuItems = [
    { icon: 'person-outline' as const, label: t('profile.edit_profile') },
    { icon: 'car-outline' as const, label: 'Vehículo' },
    { icon: 'document-text-outline' as const, label: 'Documentos' },
    { icon: 'language-outline' as const, label: t('profile.language') },
    { icon: 'settings-outline' as const, label: t('profile.settings') },
    { icon: 'help-circle-outline' as const, label: t('profile.help') },
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
            <Text variant="h4" color="inverse">{user?.full_name ?? 'Conductor'}</Text>
            <Text variant="bodySmall" color="inverse" className="opacity-50">
              {user?.phone ?? '+53 5XXXXXXX'}
            </Text>
          </View>
        </Card>

        {menuItems.map((item) => (
          <Pressable
            key={item.label}
            className="flex-row items-center py-4 border-b border-neutral-800"
          >
            <Ionicons name={item.icon} size={22} color="#A3A3A3" />
            <Text variant="body" color="inverse" className="ml-3 flex-1">
              {item.label}
            </Text>
            <Ionicons name="chevron-forward" size={20} color="#525252" />
          </Pressable>
        ))}

        <Pressable className="flex-row items-center py-4 mt-4">
          <Ionicons name="log-out-outline" size={22} color="#EF4444" />
          <Text variant="body" color="error" className="ml-3">
            {t('auth.logout')}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}
