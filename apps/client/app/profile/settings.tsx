import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Switch, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { MenuRow } from '@tricigo/ui/MenuRow';
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
    const cycle = ['es', 'en', 'pt'] as const;
    const idx = cycle.indexOf(currentLang as typeof cycle[number]);
    const next = cycle[(idx + 1) % cycle.length];
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

  const languageLabel =
    currentLang === 'es' ? t('profile.spanish') : currentLang === 'en' ? t('profile.english') : t('profile.portuguese', { defaultValue: 'Portugues' });

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <ScreenHeader title={t('profile.settings_title')} onBack={() => router.back()} />

        {/* General section */}
        <Text variant="caption" color="tertiary" className="mb-2 mt-2 uppercase tracking-wider font-semibold px-1">
          {t('profile.section_general', { defaultValue: 'General' })}
        </Text>
        <Card variant="outlined" padding="md" className="mb-6">
          <MenuRow
            icon="language-outline"
            iconBg="info"
            label={t('profile.preferred_language')}
            value={languageLabel}
            onPress={toggleLanguage}
            showBorder={true}
          />
          <MenuRow
            icon="card-outline"
            iconBg="success"
            label={t('profile.payment_method')}
            value={t('profile.payment_cash')}
            showChevron={true}
            showBorder={false}
          />
        </Card>

        {/* Appearance section */}
        <Text variant="caption" color="tertiary" className="mb-2 uppercase tracking-wider font-semibold px-1">
          {t('profile.appearance')}
        </Text>
        <Card variant="outlined" padding="md" className="mb-6">
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
        <Text variant="caption" color="tertiary" className="mb-2 uppercase tracking-wider font-semibold px-1">
          {t('profile.notifications_toggle')}
        </Text>
        <Card variant="outlined" padding="md" className="mb-6">
          <MenuRow
            icon="notifications-outline"
            iconBg="warning"
            label={t('profile.notifications_toggle')}
            showChevron={false}
            showBorder={notificationsEnabled}
            right={
              <Switch
                value={notificationsEnabled}
                onValueChange={handleNotificationToggle}
                trackColor={{ true: colors.brand.orange }}
              />
            }
          />

          {/* Granular category toggles */}
          {notificationsEnabled && (
            <View className="pt-1">
              <Text variant="caption" color="secondary" className="mb-1 mt-1 px-1">
                {t('profile.notif_section_title')}
              </Text>
              {NOTIF_CATEGORIES.map((cat, idx) => (
                <MenuRow
                  key={cat.key}
                  icon={cat.icon}
                  iconBg="neutral"
                  label={t(cat.labelKey)}
                  showChevron={false}
                  showBorder={idx < NOTIF_CATEGORIES.length - 1}
                  right={
                    <Switch
                      value={categoryPrefs[cat.key] !== false}
                      onValueChange={(v) => handleCategoryToggle(cat.key, v)}
                      trackColor={{ true: colors.brand.orange }}
                      style={{ transform: [{ scale: 0.85 }] }}
                    />
                  }
                />
              ))}
            </View>
          )}
        </Card>

        {/* SMS Alerts section */}
        <Card variant="outlined" padding="md" className="mb-6">
          <MenuRow
            icon="chatbubble-ellipses-outline"
            iconBg="primary"
            label={t('profile.notif_sms')}
            subtitle={t('profile.notif_sms_desc')}
            showChevron={false}
            showBorder={false}
            right={
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
            }
          />
        </Card>

        {/* Account deletion - Danger Zone */}
        <Text variant="caption" className="mb-2 uppercase tracking-wider font-semibold px-1 text-red-500">
          {t('profile.danger_zone', { defaultValue: 'Zona de peligro' })}
        </Text>
        <Card variant="outlined" padding="md" className="mb-8 border-red-200 dark:border-red-900">
          <View className="flex-row items-center mb-3">
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                backgroundColor: 'rgba(239, 68, 68, 0.10)',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="warning-outline" size={20} color={colors.error.DEFAULT} />
            </View>
            <View className="ml-3 flex-1">
              <Text variant="body" className="font-semibold text-red-600 dark:text-red-400">
                {t('profile.delete_account', { defaultValue: 'Eliminar cuenta' })}
              </Text>
              <Text variant="caption" color="tertiary" className="mt-0.5">
                {t('profile.delete_account_desc', { defaultValue: 'Esta accion es irreversible. Se eliminaran todos tus datos, historial de viajes y saldo.' })}
              </Text>
            </View>
          </View>
          <Pressable
            className="bg-red-500 rounded-xl py-3 items-center"
            onPress={() => {
              Alert.alert(
                t('profile.delete_account_confirm_title', { defaultValue: '¿Eliminar cuenta?' }),
                t('profile.delete_account_confirm_msg', { defaultValue: 'Esta accion no se puede deshacer. Se perderan todos tus datos, saldo y historial.' }),
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
                          t('profile.delete_account_error', { defaultValue: 'No se pudo eliminar la cuenta. Intenta de nuevo mas tarde.' }),
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
    </Screen>
  );
}
