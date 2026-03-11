import React, { useState, useEffect } from 'react';
import { View, Pressable, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { i18n } from '@tricigo/i18n';
import { notificationService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

const NOTIF_PREF_KEY = '@tricigo/notifications_enabled';

export default function DriverSettingsScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const currentLang = i18n.language ?? 'es';

  useEffect(() => {
    AsyncStorage.getItem(NOTIF_PREF_KEY).then((val) => {
      if (val !== null) setNotificationsEnabled(val === 'true');
    }).catch(() => { /* best-effort: read preference */ });
  }, []);

  const toggleLanguage = () => {
    const next = currentLang === 'es' ? 'en' : 'es';
    i18n.changeLanguage(next);
  };

  const handleNotificationToggle = async (enabled: boolean) => {
    setNotificationsEnabled(enabled);
    await AsyncStorage.setItem(NOTIF_PREF_KEY, String(enabled)).catch(() => {});

    if (!enabled && userId) {
      // Remove push token when disabling
      try {
        const tokenData = await Notifications.getExpoPushTokenAsync();
        await notificationService.removePushToken(userId, tokenData.data);
      } catch {
        /* best-effort: token removal */
      }
    }
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
              onValueChange={handleNotificationToggle}
              trackColor={{ true: colors.brand.orange }}
            />
          </View>
        </Card>
      </View>
    </Screen>
  );
}
