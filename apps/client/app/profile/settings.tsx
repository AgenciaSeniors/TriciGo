import React, { useState, useEffect, useCallback } from 'react';
import { View, Switch, Alert, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { MenuRow } from '@tricigo/ui/MenuRow';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { i18n } from '@tricigo/i18n';
import { notificationService, authService, customerService } from '@tricigo/api';
import { triggerHaptic, logger } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import type { Language, PaymentMethod, CustomerProfile } from '@tricigo/types';

const NOTIF_PREF_KEY = '@tricigo/notifications_enabled';

const NOTIF_CATEGORIES = [
  { key: 'ride_updates', icon: 'car-outline' as const, labelKey: 'profile.notif_rides' },
  { key: 'chat_messages', icon: 'chatbubble-outline' as const, labelKey: 'profile.notif_chat' },
  { key: 'payment_updates', icon: 'wallet-outline' as const, labelKey: 'profile.notif_wallet' },
  { key: 'promotions', icon: 'gift-outline' as const, labelKey: 'profile.notif_promos' },
  { key: 'driver_approval', icon: 'checkmark-circle-outline' as const, labelKey: 'profile.notif_driver_approval' },
] as const;

const LANGUAGE_CYCLE: Language[] = ['es', 'en', 'pt'];
const PAYMENT_CYCLE: PaymentMethod[] = ['cash', 'tricicoin', 'mixed'];

export default function SettingsScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const userId = user?.id;
  const reset = useAuthStore((s) => s.reset);
  const setUser = useAuthStore((s) => s.setUser);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [categoryPrefs, setCategoryPrefs] = useState<Record<string, boolean>>({});
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsLoading, setSmsLoading] = useState(false);
  const [customerProfile, setCustomerProfile] = useState<CustomerProfile | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const currentLang = (i18n.language ?? 'es') as Language;

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

      // Load customer profile (default payment method lives here, not on auth user)
      customerService.ensureProfile(userId).then((cp) => {
        setCustomerProfile(cp);
        setPaymentMethod(cp.default_payment_method);
      }).catch((err) => logger.warn('[Settings] Failed to load customer profile:', err));
    }
  }, [userId]);

  const toggleLanguage = async () => {
    triggerHaptic('light');
    const idx = LANGUAGE_CYCLE.indexOf(currentLang);
    const next = LANGUAGE_CYCLE[(idx + 1) % LANGUAGE_CYCLE.length];
    // Apply locally first so the UI reacts instantly even on slow networks.
    i18n.changeLanguage(next);
    if (!user) return;
    try {
      const updated = await authService.updateProfile(user.id, { preferred_language: next });
      setUser(updated);
    } catch (err) {
      logger.warn('[Settings] Failed to persist language:', { error: String(err) });
    }
  };

  const togglePaymentMethod = async () => {
    if (!customerProfile) return;
    triggerHaptic('light');
    const idx = PAYMENT_CYCLE.indexOf(paymentMethod);
    const next = PAYMENT_CYCLE[(idx + 1) % PAYMENT_CYCLE.length]!;
    // Optimistic update
    setPaymentMethod(next);
    try {
      await customerService.updateProfile(customerProfile.id, { default_payment_method: next });
    } catch (err) {
      // Revert on error
      setPaymentMethod(paymentMethod);
      logger.warn('[Settings] Failed to update payment method:', { error: String(err) });
    }
  };

  const paymentLabel =
    paymentMethod === 'cash'
      ? t('profile.payment_cash')
      : paymentMethod === 'tricicoin'
        ? t('profile.payment_tricicoin')
        : t('profile.payment_mixed');

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
    <Screen scroll bg="cuban" padded>
      <View className="pt-4">
        <ScreenHeader title={t('profile.settings_title')} onBack={() => router.back()} />

        {/* General section — single source of truth for language + payment.
            Dark-mode toggle lives in the Profile header card (one place only). */}
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
            value={paymentLabel}
            onPress={customerProfile ? togglePaymentMethod : undefined}
            showChevron={!!customerProfile}
            showBorder={false}
          />
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
