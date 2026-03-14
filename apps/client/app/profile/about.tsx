import React from 'react';
import { View, Pressable, Linking, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';

const APP_VERSION = '1.0.0';

export default function AboutScreen() {
  const { t } = useTranslation('common');

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
          className="flex-row items-center py-4 border-b border-neutral-100"
          onPress={() => Linking.openURL('https://tricigo.app/terms')}
        >
          <Ionicons name="document-text-outline" size={22} color={colors.neutral[600]} />
          <Text variant="body" className="ml-3 flex-1">{t('profile.terms_of_service')}</Text>
          <Ionicons name="open-outline" size={18} color={colors.neutral[400]} />
        </Pressable>

        <Pressable
          className="flex-row items-center py-4 border-b border-neutral-100"
          onPress={() => Linking.openURL('https://tricigo.app/privacy')}
        >
          <Ionicons name="shield-outline" size={22} color={colors.neutral[600]} />
          <Text variant="body" className="ml-3 flex-1">{t('profile.privacy_policy')}</Text>
          <Ionicons name="open-outline" size={18} color={colors.neutral[400]} />
        </Pressable>
      </View>
    </Screen>
  );
}
