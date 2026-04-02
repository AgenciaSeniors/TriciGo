import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Switch, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import type { ThemeMode } from '@tricigo/theme';
import { i18n } from '@tricigo/i18n';
import { notificationService, authService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useThemeStore, setThemeMode } from '@/stores/theme.store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

const NOTIF_PREF_KEY = '@tricigo/notifications_enabled';

const NOTIF_CATEGORIES = [
  { key: 'ride_updates', icon: 'car-outline' as const, labelKey: 'profile.notif_rides' },
  { key: 'chat_messages', icon: 'chatbubble-outline' as const, labelKey: 'profile.notif_chat' },
  { key: 'payment_updates', icon: 'wallet-outline' as const, labelKey: 'profile.notif_wallet' },
  { key: 'promotions', icon: 'gift-outline' as const, labelKey: 'profile.notif_promos' },
  { key: 'driver_approval', icon: 'checkmark-circle-outline' as const, labelKey: 'profile.notif_driver_approval' },
] as const;

const THEME_OPTIONS: { value: ThemeMode; labelKey: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: 'light', labelKey: 'profile.theme_light', icon: 'sunny-outline' },
  { value: 'dark', labelKey: 'profile.theme_dark', icon: 'moon-outline' },
  { value: 'system', labelKey: 'profile.theme_system', icon: 'phone-portrait-outline' },
];

export default function SettingsScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const reset = useAuthStore((s) => s.reset);
  const themeMode = useThemeStore((s) => s.mode);
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

    // Load category preferences from server
    if (userId) {
      notificationService.getPreferences(userId).then((prefs) => {
        if (prefs) {
          setCategoryPrefs({
            ride_updates: prefs.ride_updates,
            chat_messages: prefs.chat_messages,
            payment_updates: prefs.payment_updates,
            promotions: prefs.promotions,
            driver_approval: prefs.driver_approval,
          });
        }
      }).catch(() => {});

      // Load SMS preference from server
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
    if (userId) {
      try {
        await notificationService.updatePreferences(userId, { [key]: enabled });
      } catch {
        // Revert on error
        setCategoryPrefs((prev) => ({ ...prev, [key]: !enabled }));
      }
    }
  }, [userId]);

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

        {/* Appearance / Dark mode section */}
        <Card variant="outlined" padding="md" className="mb-4">
          <View className="flex-row items-center mb-3">
            <Ionicons name="color-palette-outline" size={22} color={colors.neutral[600]} />
            <Text variant="body" className="ml-3">{t('profile.appearance')}</Text>
          </View>
          <View className="flex-row rounded-lg overflow-hidden border border-neutral-200 dark:border-neutral-700">
            {THEME_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => setThemeMode(option.value)}
                className={`flex-1 py-2.5 items-center flex-row justify-center ${
                  themeMode === option.value
                    ? 'bg-primary-500'
                    : 'bg-neutral-50 dark:bg-neutral-800'
                }`}
              >
                <Ionicons
                  name={option.icon}
                  size={16}
                  color={themeMode === option.value ? '#FFFFFF' : colors.neutral[500]}
                />
                <Text
                  variant="caption"
                  color={themeMode === option.value ? 'inverse' : 'secondary'}
                  className="ml-1.5"
                >
                  {t(option.labelKey)}
                </Text>
              </Pressable>
            ))}
          </View>
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

        {/* Account deletion */}
        <View className="mt-8 mb-8">
          <Text variant="caption" color="tertiary" className="mb-2 uppercase tracking-wider font-semibold">
            {t('profile.danger_zone', { defaultValue: 'Zona de peligro' })}
          </Text>
          <Card variant="outlined" padding="md" className="border-red-200 dark:border-red-900">
            <View className="flex-row items-center mb-2">
              <Ionicons name="warning-outline" size={20} color={colors.error.DEFAULT} />
              <Text variant="body" className="ml-2 font-semibold text-red-600 dark:text-red-400">
                {t('profile.delete_account', { defaultValue: 'Eliminar cuenta' })}
              </Text>
            </View>
            <Text variant="caption" color="secondary" className="mb-3">
              {t('profile.delete_account_desc', { defaultValue: 'Esta acción es irreversible. Se eliminarán todos tus datos, historial de viajes y saldo.' })}
            </Text>
            <Pressable
              className="bg-red-500 rounded-xl py-3 items-center"
              onPress={() => {
                Alert.alert(
                  t('profile.delete_account_confirm_title', { defaultValue: '¿Eliminar cuenta?' }),
                  t('profile.delete_account_confirm_msg', { defaultValue: 'Esta acción no se puede deshacer. Se perderán todos tus datos, saldo y historial.' }),
                  [
                    { text: t('common.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
                    {
                      text: t('profile.delete_account', { defaultValue: 'Eliminar cuenta' }),
                      style: 'destructive',
                      onPress: async () => {
                        if (!userId) return;
                        try {
                          await authService.deleteAccount(userId);
                          reset();
                        } catch {
                          Alert.alert(
                            t('errors.generic_title', { defaultValue: 'Error' }),
                            t('profile.delete_account_error', { defaultValue: 'No se pudo eliminar la cuenta. Intenta de nuevo más tarde.' }),
                          );
                        }
                      },
                    },
                  ],
                );
              }}
            >
              <Text variant="body" className="text-white font-semibold">
                {t('profile.delete_account', { defaultValue: 'Eliminar cuenta' })}
              </Text>
            </Pressable>
          </Card>
        </View>
      </View>
    </Screen>
  );
}
