import React from 'react';
import { View, Image, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { MenuRow } from '@tricigo/ui/MenuRow';
import { ProfileScreenHeader } from '@tricigo/ui/ProfileScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber, cubanLight, cubanDark } from '@tricigo/theme';
import Constants from 'expo-constants';

// Read the version from the build instead of hardcoding it. This was
// pinned at '1.0.0' while app.json had long moved on (1.3.0 at the time
// of writing), so the screen misreported the build to anyone who asked
// support "what version are you on?". The `?? '—'` avoids inventing a
// number if the manifest is somehow unavailable.
const APP_VERSION = Constants.expoConfig?.version ?? '—';

type RoutePath = Parameters<typeof router.push>[0];

export default function AboutScreen() {
  const { t } = useTranslation('common');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;

  const links: { label: string; icon: React.ComponentProps<typeof Ionicons>['name']; route: RoutePath; iconBg: 'primary' | 'info' | 'success' }[] = [
    { label: t('profile.terms_of_service'), icon: 'document-text-outline', route: '/profile/terms', iconBg: 'primary' },
    { label: t('profile.privacy_policy'), icon: 'shield-outline', route: '/profile/privacy', iconBg: 'info' },
    { label: t('profile.blog', { defaultValue: 'Blog' }), icon: 'newspaper-outline', route: '/profile/blog', iconBg: 'success' },
  ];

  return (
    <Screen scroll bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'} padded>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
      <View className="pt-4">
        <ProfileScreenHeader
          title={t('profile.about_title')}
          onBack={() => router.back()}
          backAccessibilityLabel={t('common.back', { defaultValue: 'Back' })}
        />

        {/* App info */}
        <View className="items-center mb-8">
          <View className="mb-3 rounded-2xl overflow-hidden" style={{ elevation: 6 }}>
            <Image
              source={require('../../assets/icon.png')}
              style={{ width: 80, height: 80, borderRadius: 16 }}
            />
          </View>
          <Text variant="h4" color="primary">TriciGo Driver</Text>
          <Text variant="bodySmall" color="secondary">
            {t('profile.version', { version: APP_VERSION, defaultValue: `v${APP_VERSION}` })}
          </Text>
        </View>

        <View
          className="rounded-2xl p-4 mb-6"
          style={{ backgroundColor: midnightEmber.screen.bg.surface, borderWidth: 1, borderColor: midnightEmber.screen.line.default }}
        >
          <Text variant="bodySmall" color="secondary" className="text-center">
            {t('profile.about_description', { defaultValue: 'TriciGo es la plataforma de movilidad urbana para conductores en la Tríplice Fronteira.' })}
          </Text>
        </View>

        {links.map((link, i) => (
          <MenuRow
            key={String(link.route)}
            icon={link.icon}
            label={link.label}
            iconBg={link.iconBg}
            onPress={() => router.push(link.route)}
            showBorder={i < links.length - 1}

          />
        ))}
      </View>
      </View>
    </Screen>
  );
}
