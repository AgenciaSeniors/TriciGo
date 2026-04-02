import React from 'react';
import { View, Pressable, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { colors, darkColors } from '@tricigo/theme';
import { useThemeStore } from '@/stores/theme.store';

const APP_VERSION = '1.0.0';

export default function AboutScreen() {
  const { t } = useTranslation('common');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <ScreenHeader title={t('profile.about_title')} onBack={() => router.back()} />

        <View className="items-center mb-8">
          <View style={{
            shadowColor: '#000',
            shadowOpacity: 0.15,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 4 },
            elevation: 6,
            borderRadius: 18,
          }} className="mb-3">
            <Image
              source={require('../../assets/icon.png')}
              style={{ width: 80, height: 80, borderRadius: 18 }}
            />
          </View>
          <Text variant="h4">{t('app_name')}</Text>
          <Text variant="bodySmall" color="secondary">
            {t('profile.version', { version: APP_VERSION })}
          </Text>
        </View>

        <Card variant="outlined" padding="md" className="mb-4">
          <Text variant="bodySmall" color="secondary" className="text-center">
            {t('profile.about_description')}
          </Text>
        </Card>

        <Pressable
          className="flex-row items-center py-4 border-b border-neutral-100 dark:border-neutral-800"
          onPress={() => router.push('/profile/terms')}
        >
          <Ionicons name="document-text-outline" size={22} color={isDark ? darkColors.text.secondary : colors.neutral[600]} />
          <Text variant="body" className="ml-3 flex-1">{t('profile.terms_of_service')}</Text>
          <Ionicons name="chevron-forward" size={18} color={isDark ? darkColors.text.tertiary : colors.neutral[400]} />
        </Pressable>

        <Pressable
          className="flex-row items-center py-4 border-b border-neutral-100 dark:border-neutral-800"
          onPress={() => router.push('/profile/privacy')}
        >
          <Ionicons name="shield-outline" size={22} color={isDark ? darkColors.text.secondary : colors.neutral[600]} />
          <Text variant="body" className="ml-3 flex-1">{t('profile.privacy_policy')}</Text>
          <Ionicons name="chevron-forward" size={18} color={isDark ? darkColors.text.tertiary : colors.neutral[400]} />
        </Pressable>
      </View>
    </Screen>
  );
}
