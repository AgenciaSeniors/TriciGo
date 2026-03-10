import React, { useState } from 'react';
import { View, Pressable, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { i18n } from '@tricigo/i18n';

export default function DriverSettingsScreen() {
  const { t } = useTranslation('common');
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const currentLang = i18n.language ?? 'es';

  const toggleLanguage = () => {
    const next = currentLang === 'es' ? 'en' : 'es';
    i18n.changeLanguage(next);
  };

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color="#FAFAFA" />
          </Pressable>
          <Text variant="h3" color="inverse">{t('profile.settings_title')}</Text>
        </View>

        <Card variant="filled" padding="md" className="mb-4 bg-neutral-800">
          <Pressable onPress={toggleLanguage} className="flex-row items-center justify-between">
            <View className="flex-row items-center">
              <Ionicons name="language-outline" size={22} color="#A3A3A3" />
              <Text variant="body" color="inverse" className="ml-3">{t('profile.preferred_language')}</Text>
            </View>
            <Text variant="body" color="accent">
              {currentLang === 'es' ? t('profile.spanish') : t('profile.english')}
            </Text>
          </Pressable>
        </Card>

        <Card variant="filled" padding="md" className="mb-4 bg-neutral-800">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center">
              <Ionicons name="notifications-outline" size={22} color="#A3A3A3" />
              <Text variant="body" color="inverse" className="ml-3">{t('profile.notifications_toggle')}</Text>
            </View>
            <Switch
              value={notificationsEnabled}
              onValueChange={setNotificationsEnabled}
              trackColor={{ true: '#FF4D00' }}
            />
          </View>
        </Card>
      </View>
    </Screen>
  );
}
