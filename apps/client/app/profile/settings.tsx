import React, { useState } from 'react';
import { View, Pressable, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { i18n } from '@tricigo/i18n';

export default function SettingsScreen() {
  const { t } = useTranslation('common');
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const currentLang = i18n.language ?? 'es';

  const toggleLanguage = () => {
    const next = currentLang === 'es' ? 'en' : 'es';
    i18n.changeLanguage(next);
  };

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color="#171717" />
          </Pressable>
          <Text variant="h3">{t('profile.settings_title')}</Text>
        </View>

        <Card variant="outlined" padding="md" className="mb-4">
          <Pressable onPress={toggleLanguage} className="flex-row items-center justify-between">
            <View className="flex-row items-center">
              <Ionicons name="language-outline" size={22} color="#525252" />
              <Text variant="body" className="ml-3">{t('profile.preferred_language')}</Text>
            </View>
            <Text variant="body" color="primary">
              {currentLang === 'es' ? t('profile.spanish') : t('profile.english')}
            </Text>
          </Pressable>
        </Card>

        <Card variant="outlined" padding="md" className="mb-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center">
              <Ionicons name="notifications-outline" size={22} color="#525252" />
              <Text variant="body" className="ml-3">{t('profile.notifications_toggle')}</Text>
            </View>
            <Switch
              value={notificationsEnabled}
              onValueChange={setNotificationsEnabled}
              trackColor={{ true: '#FF4D00' }}
            />
          </View>
        </Card>

        <Card variant="outlined" padding="md" className="mb-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center">
              <Ionicons name="card-outline" size={22} color="#525252" />
              <Text variant="body" className="ml-3">{t('profile.payment_method')}</Text>
            </View>
            <Text variant="body" color="secondary">{t('profile.payment_cash')}</Text>
          </View>
        </Card>
      </View>
    </Screen>
  );
}
