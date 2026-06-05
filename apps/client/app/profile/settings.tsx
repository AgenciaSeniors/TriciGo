import React, { useState, useEffect, useCallback } from 'react';
import { View, Switch, Alert } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { ProfileSection } from '@/components/profile/ProfileSection';
import { ProfileRow } from '@/components/profile/ProfileRow';
import { useTokens } from '@/hooks/useTokens';
import { useTranslation } from '@tricigo/i18n';
import { i18n } from '@tricigo/i18n';
import { notificationService, authService, customerService } from '@tricigo/api';
import { triggerHaptic, logger } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
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
  const tokens = useTokens();
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
        const tokenData = await Notifications.getExpoPushTokenAsync({
          projectId: Constants.expoConfig?.extra?.eas?.projectId,
        });
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

        <View style={{ height: 12 }} />

        {/* General — language + payment. Dark-mode toggle lives in Profile. */}
        <ProfileSection title={t('profile.section_general', { defaultValue: 'General' })}>
          <ProfileRow
            icon="language-outline"
            tint="#3B82F6"
            label={t('profile.preferred_language')}
            value={languageLabel}
            onPress={toggleLanguage}
          />
          <ProfileRow
            icon="card-outline"
            tint="#22C55E"
            label={t('profile.payment_method')}
            value={paymentLabel}
            onPress={customerProfile ? togglePaymentMethod : undefined}
            isLast
          />
        </ProfileSection>

        {/* Notifications */}
        <ProfileSection title={t('profile.notifications_toggle')}>
          <ProfileRow
            icon="notifications-outline"
            tint="#F59E0B"
            label={t('profile.notifications_toggle')}
            isLast={!notificationsEnabled}
            right={
              <Switch
                value={notificationsEnabled}
                onValueChange={handleNotificationToggle}
                trackColor={{ false: tokens.line, true: tokens.accent.orange }}
                thumbColor="#FFFFFF"
                ios_backgroundColor={tokens.line}
              />
            }
          />
          {notificationsEnabled &&
            NOTIF_CATEGORIES.map((cat, idx) => (
              <ProfileRow
                key={cat.key}
                icon={cat.icon}
                tint={tokens.ink.secondary}
                label={t(cat.labelKey)}
                isLast={idx === NOTIF_CATEGORIES.length - 1}
                right={
                  <Switch
                    value={categoryPrefs[cat.key] !== false}
                    onValueChange={(v) => handleCategoryToggle(cat.key, v)}
                    trackColor={{ false: tokens.line, true: tokens.accent.orange }}
                    thumbColor="#FFFFFF"
                    ios_backgroundColor={tokens.line}
                    style={{ transform: [{ scale: 0.85 }] }}
                  />
                }
              />
            ))}
        </ProfileSection>

        {/* SMS alerts */}
        <ProfileSection>
          <ProfileRow
            icon="chatbubble-ellipses-outline"
            tint="#FF4D00"
            label={t('profile.notif_sms')}
            subtitle={t('profile.notif_sms_desc')}
            isLast
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
                trackColor={{ false: tokens.line, true: tokens.accent.orange }}
                thumbColor="#FFFFFF"
                ios_backgroundColor={tokens.line}
              />
            }
          />
        </ProfileSection>

        {/* Danger zone — delete account */}
        <ProfileSection title={t('profile.danger_zone', { defaultValue: 'Zona de peligro' })} marginBottom={32}>
          <ProfileRow
            icon="warning-outline"
            destructive
            label={t('profile.delete_account', { defaultValue: 'Eliminar cuenta' })}
            subtitle={t('profile.delete_account_desc', {
              defaultValue:
                'Esta acción es inmediata e irreversible. Se eliminarán permanentemente tu cuenta, perfil y saldo. El historial de viajes se conserva anonimizado por requisitos de auditoría financiera.',
            })}
            isLast
            onPress={() => {
              Alert.alert(
                t('profile.delete_account_confirm_title', { defaultValue: '¿Eliminar cuenta?' }),
                t('profile.delete_account_confirm_msg', {
                  defaultValue:
                    'Esta acción no se puede deshacer. Se eliminarán inmediatamente tu cuenta, perfil y saldo. El historial de viajes se anonimiza (no se borra) para cumplir con la normativa de auditoría financiera.',
                }),
                [
                  { text: t('common.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
                  {
                    text: t('profile.delete_account', { defaultValue: 'Eliminar cuenta' }),
                    style: 'destructive',
                    onPress: async () => {
                      // BUG-Store-Readiness-Client: hard-delete via edge function
                      // derives user_id from JWT — no userId param needed.
                      try {
                        await authService.deleteAccount();
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
          />
        </ProfileSection>
      </View>
    </Screen>
  );
}
