import React, { useState, useEffect } from 'react';
import { View, Pressable, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { i18n } from '@tricigo/i18n';
import { notificationService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

const NOTIF_PREF_KEY = '@tricigo/notifications_enabled';

export default function SettingsScreen() {
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
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <ScreenHeader title={t('profile.settings_title')} onBack={() => router.back()} />

        <Card variant="outlined" padding="md" className="mb-4">
          <Pressable onPress={toggleLanguage} className="flex-row items-center justify-between">
            <View className="flex-row items-center">
              <Ionicons name="language-outline" size={22} color={colors.neutral[600]} />
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
              <Ionicons name="notifications-outline" size={22} color={colors.neutral[600]} />
              <Text variant="body" className="ml-3">{t('profile.notifications_toggle')}</Text>
            </View>
            <Switch
              value={notificationsEnabled}
              onValueChange={handleNotificationToggle}
              trackColor={{ true: colors.brand.orange }}
            />
          </View>
        </Card>

        <Card variant="outlined" padding="md" className="mb-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center">
              <Ionicons name="card-outline" size={22} color={colors.neutral[600]} />
              <Text variant="body" className="ml-3">{t('profile.payment_method')}</Text>
            </View>
            <Text variant="body" color="secondary">{t('profile.payment_cash')}</Text>
          </View>
        </Card>
      </View>
    </Screen>
  );
}
