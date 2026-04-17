import React from 'react';
import { View, Image } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { MenuRow } from '@tricigo/ui/MenuRow';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';

const APP_VERSION = '1.0.0';

export default function AboutScreen() {
  const { t } = useTranslation('common');

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <ScreenHeader title={t('profile.about_title')} onBack={() => router.back()} />

        {/* App logo & version */}
        <View className="items-center mb-8">
          <View
            style={{
              shadowColor: '#000',
              shadowOpacity: 0.12,
              shadowRadius: 16,
              shadowOffset: { width: 0, height: 6 },
              elevation: 8,
              borderRadius: 22,
            }}
            className="mb-4"
          >
            <Image
              source={require('../../assets/icon.png')}
              style={{ width: 88, height: 88, borderRadius: 22 }}
              accessibilityLabel="TriciGo logo"
            />
          </View>
          <Text variant="h3">{t('app_name')}</Text>
          <Text variant="bodySmall" color="tertiary" className="mt-1">
            {t('profile.version', { version: APP_VERSION })}
          </Text>
        </View>

        {/* Description */}
        <Card variant="filled" padding="md" className="mb-6">
          <Text variant="body" color="secondary" className="text-center leading-relaxed">
            {t('profile.about_description')}
          </Text>
        </Card>

        {/* Legal links */}
        <Text variant="caption" color="tertiary" className="mb-2 uppercase tracking-wider font-semibold">
          {t('profile.about_legal', { defaultValue: 'Legal' })}
        </Text>
        <MenuRow
          icon="document-text-outline"
          label={t('profile.terms_of_service')}
          iconBg="neutral"
          onPress={() => router.push('/profile/terms')}
        />
        <MenuRow
          icon="shield-outline"
          label={t('profile.privacy_policy')}
          iconBg="info"
          onPress={() => router.push('/profile/privacy')}
          showBorder={false}
        />
      </View>
    </Screen>
  );
}
