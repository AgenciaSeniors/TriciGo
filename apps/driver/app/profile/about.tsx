import React from 'react';
import { View, Pressable, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { MenuRow } from '@tricigo/ui/MenuRow';
import { useTranslation } from '@tricigo/i18n';
import { colors, driverDarkColors } from '@tricigo/theme';

const APP_VERSION = '1.0.0';

export default function AboutScreen() {
  const { t } = useTranslation('common');

  const links: { label: string; icon: React.ComponentProps<typeof Ionicons>['name']; route: string; iconBg: 'primary' | 'info' | 'success' }[] = [
    { label: t('profile.terms_of_service'), icon: 'document-text-outline', route: '/profile/terms', iconBg: 'primary' },
    { label: t('profile.privacy_policy'), icon: 'shield-outline', route: '/profile/privacy', iconBg: 'info' },
    { label: t('profile.blog', { defaultValue: 'Blog' }), icon: 'newspaper-outline', route: '/profile/blog', iconBg: 'success' },
  ];

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        {/* Header */}
        <View className="flex-row items-center mb-6">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.back', { defaultValue: 'Back' })}
            className="mr-3 w-11 h-11 rounded-xl items-center justify-center"
            style={{ backgroundColor: driverDarkColors.hover }}
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
          style={{ backgroundColor: driverDarkColors.card, borderWidth: 1, borderColor: driverDarkColors.border.default }}
        >
          <Text variant="bodySmall" color="secondary" className="text-center">
            {t('profile.about_description', { defaultValue: 'TriciGo es la plataforma de movilidad urbana para conductores en la Tríplice Fronteira.' })}
          </Text>
        </View>

        {links.map((link, i) => (
          <MenuRow
            key={link.route}
            icon={link.icon}
            label={link.label}
            iconBg={link.iconBg}
            onPress={() => router.push(link.route as never)}
            showBorder={i < links.length - 1}
            forceDark
          />
        ))}
      </View>
    </Screen>
  );
}
