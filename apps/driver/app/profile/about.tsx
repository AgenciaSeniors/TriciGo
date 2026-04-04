import React from 'react';
import { View, Pressable, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';

const APP_VERSION = '1.0.0';
const CARD_BG = '#141414';
const BORDER = '#2a2a2a';

export default function AboutScreen() {
  const { t } = useTranslation('common');

  const links = [
    { label: t('profile.terms_of_service'), icon: 'document-text-outline' as const, route: '/profile/terms' },
    { label: t('profile.privacy_policy'), icon: 'shield-outline' as const, route: '/profile/privacy' },
    { label: t('profile.blog', { defaultValue: 'Blog' }), icon: 'newspaper-outline' as const, route: '/profile/blog' },
  ];

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        {/* Header */}
        <View className="flex-row items-center mb-6">
          <Pressable
            onPress={() => router.back()}
            className="mr-3 w-10 h-10 rounded-xl bg-[#1e1e1e] items-center justify-center"
          >
            <Ionicons name="arrow-back" size={20} color={colors.neutral[50]} />
          </Pressable>
          <Text variant="h3" color="inverse">{t('profile.about_title')}</Text>
        </View>

        {/* App info */}
        <View className="items-center mb-8">
          <View className="mb-3 rounded-2xl overflow-hidden" style={{ elevation: 6 }}>
            <Image
              source={require('../../assets/icon.png')}
              style={{ width: 80, height: 80, borderRadius: 16 }}
            />
          </View>
          <Text variant="h4" color="inverse">TriciGo Driver</Text>
          <Text variant="bodySmall" color="secondary">
            {t('profile.version', { version: APP_VERSION, defaultValue: `v${APP_VERSION}` })}
          </Text>
        </View>

        <View
          className="rounded-2xl p-4 mb-6"
          style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER }}
        >
          <Text variant="bodySmall" color="secondary" className="text-center">
            {t('profile.about_description', { defaultValue: 'TriciGo es la plataforma de movilidad urbana para conductores en la Tríplice Fronteira.' })}
          </Text>
        </View>

        {links.map((link, i) => (
          <Pressable
            key={link.route}
            onPress={() => router.push(link.route as never)}
            className="flex-row items-center py-4"
            style={{ borderBottomWidth: i < links.length - 1 ? 1 : 0, borderBottomColor: BORDER }}
          >
            <View className="w-9 h-9 rounded-xl bg-[#1e1e1e] items-center justify-center mr-3">
              <Ionicons name={link.icon} size={18} color={colors.brand.orange} />
            </View>
            <Text variant="body" color="inverse" className="flex-1">{link.label}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.neutral[500]} />
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}
