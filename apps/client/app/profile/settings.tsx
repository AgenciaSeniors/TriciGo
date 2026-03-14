import React, { useState, useEffect, useCallback } from 'react';
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

const NOTIF_CATEGORIES = [
  { key: '@tricigo/notif_rides', icon: 'car-outline' as const, labelKey: 'profile.notif_rides' },
  { key: '@tricigo/notif_chat', icon: 'chatbubble-outline' as const, labelKey: 'profile.notif_chat' },
  { key: '@tricigo/notif_wallet', icon: 'wallet-outline' as const, labelKey: 'profile.notif_wallet' },
  { key: '@tricigo/notif_promos', icon: 'gift-outline' as const, labelKey: 'profile.notif_promos' },
];

export default function SettingsScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [categoryPrefs, setCategoryPrefs] = useState<Record<string, boolean>>({});
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsLoading, setSmsLoading] = useState(false);
  const currentLang = i18n.language ?? 'es';

  useEffect(() => {
    // Load master toggle
    AsyncStorage.getItem(NOTIF_PREF_KEY).then((val) => {
      if (val !== null) setNotificationsEnabled(val === 'true');
    }).catch(() => {});

    // Load category preferences
    Promise.all(
      NOTIF_CATEGORIES.map(async (cat) => {
        const val = await AsyncStorage.getItem(cat.key).catch(() => null);
        return [cat.key, val !== 'false'] as const;  // default true
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

        {/* Notifications section */}
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

          {/* Granular category toggles */}
          {notificationsEnabled && (
            <View className="mt-3 pt-3 border-t border-neutral-100">
              <Text variant="caption" color="secondary" className="mb-2">
                {t('profile.notif_section_title')}
              </Text>
              {NOTIF_CATEGORIES.map((cat) => (
                <View
                  key={cat.key}
                  className="flex-row items-center justify-between py-2"
                >
                  <View className="flex-row items-center">
                    <Ionicons name={cat.icon} size={18} color={colors.neutral[400]} />
                    <Text variant="bodySmall" className="ml-2.5">
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
        <Card variant="outlined" padding="md" className="mb-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center flex-1 mr-3">
              <Ionicons name="chatbubble-ellipses-outline" size={22} color={colors.neutral[600]} />
              <View className="ml-3 flex-1">
                <Text variant="body">{t('profile.notif_sms')}</Text>
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
                  setSmsEnabled(!enabled); // revert on error
                } finally {
                  setSmsLoading(false);
                }
              }}
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
