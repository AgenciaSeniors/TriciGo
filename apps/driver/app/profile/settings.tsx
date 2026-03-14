import React, { useState, useEffect, useCallback } from 'react';
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

const NOTIF_CATEGORIES = [
  { key: '@tricigo/notif_rides', icon: 'car-outline' as const, labelKey: 'profile.notif_trip_requests' },
  { key: '@tricigo/notif_chat', icon: 'chatbubble-outline' as const, labelKey: 'profile.notif_chat' },
  { key: '@tricigo/notif_wallet', icon: 'wallet-outline' as const, labelKey: 'profile.notif_wallet' },
];

export default function DriverSettingsScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [categoryPrefs, setCategoryPrefs] = useState<Record<string, boolean>>({});
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsLoading, setSmsLoading] = useState(false);
  const currentLang = i18n.language ?? 'es';

  useEffect(() => {
    AsyncStorage.getItem(NOTIF_PREF_KEY).then((val) => {
      if (val !== null) setNotificationsEnabled(val === 'true');
    }).catch(() => {});

    Promise.all(
      NOTIF_CATEGORIES.map(async (cat) => {
        const val = await AsyncStorage.getItem(cat.key).catch(() => null);
        return [cat.key, val !== 'false'] as const;
      }),
    ).then((results) => {
      setCategoryPrefs(Object.fromEntries(results));
    });

    // Load SMS preference from server
    if (userId) {
      notificationService.getSmsPreference(userId).then(setSmsEnabled).catch(() => {});
    }
  }, [userId]);

  const toggleLanguage = () => {
    const next = currentLang === 'es' ? 'en' : 'es';
    i18n.changeLanguage(next);
  };

  const handleNotificationToggle = async (enabled: boolean) => {
    setNotificationsEnabled(enabled);
    await AsyncStorage.setItem(NOTIF_PREF_KEY, String(enabled)).catch(() => {});

    if (!enabled && userId) {
      try {
        const tokenData = await Notifications.getExpoPushTokenAsync();
        await notificationService.removePushToken(userId, tokenData.data);
      } catch {
        /* best-effort */
      }
    }
  };

  const handleCategoryToggle = useCallback(async (key: string, enabled: boolean) => {
    setCategoryPrefs((prev) => ({ ...prev, [key]: enabled }));
    await AsyncStorage.setItem(key, String(enabled)).catch(() => {});
  }, []);

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color={colors.neutral[50]} />
          </Pressable>
          <Text variant="h3" color="inverse">{t('profile.settings_title')}</Text>
        </View>

        <Card variant="filled" padding="md" className="mb-4 bg-neutral-800">
          <Pressable onPress={toggleLanguage} className="flex-row items-center justify-between">
            <View className="flex-row items-center">
              <Ionicons name="language-outline" size={22} color={colors.neutral[400]} />
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
              <Ionicons name="notifications-outline" size={22} color={colors.neutral[400]} />
              <Text variant="body" color="inverse" className="ml-3">{t('profile.notifications_toggle')}</Text>
            </View>
            <Switch
              value={notificationsEnabled}
              onValueChange={handleNotificationToggle}
              trackColor={{ true: colors.brand.orange }}
            />
          </View>

          {/* Granular category toggles */}
          {notificationsEnabled && (
            <View className="mt-3 pt-3 border-t border-neutral-700">
              <Text variant="caption" color="secondary" className="mb-2">
                {t('profile.notif_section_title')}
              </Text>
              {NOTIF_CATEGORIES.map((cat) => (
                <View
                  key={cat.key}
                  className="flex-row items-center justify-between py-2"
                >
                  <View className="flex-row items-center">
                    <Ionicons name={cat.icon} size={18} color={colors.neutral[500]} />
                    <Text variant="bodySmall" color="inverse" className="ml-2.5">
                      {t(cat.labelKey)}
                    </Text>
                  </View>
                  <Switch
                    value={categoryPrefs[cat.key] !== false}
                    onValueChange={(v) => handleCategoryToggle(cat.key, v)}
                    trackColor={{ true: colors.brand.orange }}
                    style={{ transform: [{ scale: 0.85 }] }}
                  />
                </View>
              ))}
            </View>
          )}
        </Card>

        {/* SMS Alerts section */}
        <Card variant="filled" padding="md" className="mb-4 bg-neutral-800">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center flex-1 mr-3">
              <Ionicons name="chatbubble-ellipses-outline" size={22} color={colors.neutral[400]} />
              <View className="ml-3 flex-1">
                <Text variant="body" color="inverse">{t('profile.notif_sms')}</Text>
                <Text variant="caption" color="secondary">
                  {t('profile.notif_sms_desc')}
                </Text>
              </View>
            </View>
            <Switch
              value={smsEnabled}
              disabled={smsLoading}
              onValueChange={async (enabled) => {
                if (!userId) return;
                setSmsEnabled(enabled);
                setSmsLoading(true);
                try {
                  await notificationService.updateSmsPreference(userId, enabled);
                } catch {
                  setSmsEnabled(!enabled);
                } finally {
                  setSmsLoading(false);
                }
              }}
              trackColor={{ true: colors.brand.orange }}
            />
          </View>
        </Card>
      </View>
    </Screen>
  );
}
