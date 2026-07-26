import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Switch, Alert } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { ProfileSection } from '@/components/profile/ProfileSection';
import { ProfileRow } from '@/components/profile/ProfileRow';
import { useTokens } from '@/hooks/useTokens';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import {
  registerPushTokenForUser,
  syncNotifPrefsToDevice,
  readDeviceNotifPrefs,
  type ServerNotifPref,
} from '@/hooks/useNotifications';
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

// Only categories a passenger can actually receive. `driver_approval`
// used to be listed here too — it is a driver-only notification, so the
// row let passengers toggle something that was never sent to them.
const NOTIF_CATEGORIES = [
  { key: 'ride_updates', icon: 'car-outline' as const, labelKey: 'profile.notif_rides' },
  { key: 'chat_messages', icon: 'chatbubble-outline' as const, labelKey: 'profile.notif_chat' },
  { key: 'payment_updates', icon: 'wallet-outline' as const, labelKey: 'profile.notif_wallet' },
  { key: 'promotions', icon: 'gift-outline' as const, labelKey: 'profile.notif_promos' },
] as const satisfies readonly { key: ServerNotifPref; icon: string; labelKey: string }[];

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
  // Keyed by `notification_preferences` column, so a typo in a category
  // key fails to compile instead of silently never matching.
  const [categoryPrefs, setCategoryPrefs] = useState<Partial<Record<ServerNotifPref, boolean>>>({});
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsLoading, setSmsLoading] = useState(false);
  const [customerProfile, setCustomerProfile] = useState<CustomerProfile | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const currentLang = (i18n.language ?? 'es') as Language;
  // Bumped on every category toggle; a load that started before the bump
  // discards its result instead of overwriting the user's choice.
  const prefsGenerationRef = useRef(0);

  const loadSettings = useCallback(() => {
    // Load master toggle
    AsyncStorage.getItem(NOTIF_PREF_KEY).then((val) => {
      if (val !== null) setNotificationsEnabled(val === 'true');
    }).catch(() => {});

    // Snapshot the toggle generation for this load. `loadSettings` runs on
    // mount AND on every focus/foreground (useRefreshOnFocus), so a server
    // response can land after the user has already flipped a switch. Without
    // this guard the stale response overwrote both the UI and the device key,
    // silently undoing the change — and on a slow connection that window is
    // seconds wide, not milliseconds.
    const generation = prefsGenerationRef.current;

    // Paint the switches from the on-device values first. Those are what
    // actually gate delivery, and they're available immediately — before
    // this, the switches rendered "on" for everything until the server
    // replied, briefly lying to a user who had turned something off.
    readDeviceNotifPrefs().then((devicePrefs) => {
      if (prefsGenerationRef.current !== generation) return;
      setCategoryPrefs(devicePrefs);
    }).catch(() => {});

    // Load category preferences from server
    if (userId) {
      notificationService.getPreferences(userId).then((prefs) => {
        if (!prefs) return;
        // The user touched a switch while this was in flight — their choice
        // is newer than this response. Dropping it is the only safe option:
        // applying it would revert them, and merging per-key would still
        // race on the key they just changed.
        if (prefsGenerationRef.current !== generation) return;

        const next = {
          ride_updates: prefs.ride_updates,
          chat_messages: prefs.chat_messages,
          payment_updates: prefs.payment_updates,
          promotions: prefs.promotions,
        };
        setCategoryPrefs(next);
        // The server is the cross-device source of truth, but the
        // handler only reads AsyncStorage — mirror it down, otherwise a
        // preference set on the web never takes effect on this phone.
        syncNotifPrefsToDevice(next);
      }).catch(() => {
        // Offline / RPC failure: the device values loaded above stay in
        // force, so the last known preferences still apply.
      });

      // Load SMS preference from server
      notificationService.getSmsPreference(userId).then(setSmsEnabled).catch(() => {});

      // Load customer profile (default payment method lives here, not on auth user)
      customerService.ensureProfile(userId).then((cp) => {
        setCustomerProfile(cp);
        setPaymentMethod(cp.default_payment_method);
      }).catch((err) => logger.warn('[Settings] Failed to load customer profile:', err));
    }
  }, [userId]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  // Stale-on-mount: re-read prefs / payment method / SMS on focus + foreground
  // (so a change from another device or admin sync shows without a restart).
  useRefreshOnFocus(loadSettings);

  const toggleLanguage = async () => {
    triggerHaptic('light');
    const idx = LANGUAGE_CYCLE.indexOf(currentLang);
    const next = LANGUAGE_CYCLE[(idx + 1) % LANGUAGE_CYCLE.length] ?? 'es';
    // Apply locally first so the UI reacts instantly even on slow networks.
    i18n.changeLanguage(next);
    // Persist locally so the choice survives an app restart — app-providers reads
    // `tricigo_language` on boot (the server `preferred_language` below is for
    // cross-device sync but was never read back, so the choice used to reset to
    // the device locale on every relaunch).
    AsyncStorage.setItem('tricigo_language', next).catch(() => {});
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

    if (!userId) return;

    if (!enabled) {
      try {
        const tokenData = await Notifications.getExpoPushTokenAsync({
          projectId: Constants.expoConfig?.extra?.eas?.projectId,
        });
        await notificationService.removePushToken(userId, tokenData.data);
      } catch {
        /* best-effort */
      }
      return;
    }

    // Turning the switch back ON must re-register the token: the OFF
    // branch above deleted it server-side. Writing AsyncStorage alone
    // left the server with no token — and no way to reach the user —
    // until the next cold start, while the switch showed "on".
    const result = await registerPushTokenForUser(userId);

    if (result === 'denied') {
      // The OS permission is off, so nothing we do in-app can deliver a
      // notification. Don't leave the switch claiming otherwise.
      setNotificationsEnabled(false);
      await AsyncStorage.setItem(NOTIF_PREF_KEY, 'false').catch(() => {});
      Alert.alert(
        t('profile.notif_permission_title', { defaultValue: 'Notificaciones bloqueadas' }),
        t('profile.notif_permission_msg', {
          defaultValue:
            'Tu teléfono tiene las notificaciones de TriciGo desactivadas. Actívalas desde los ajustes del sistema para volver a recibirlas.',
        }),
      );
    }
    // 'error' is transient (network, Expo token service). Leave the
    // switch on: useNotificationSetup retries on the next foreground.
  };

  const handleCategoryToggle = useCallback(async (key: ServerNotifPref, enabled: boolean) => {
    // Invalidate any load already in flight — its data predates this choice.
    prefsGenerationRef.current += 1;
    setCategoryPrefs((prev) => ({ ...prev, [key]: enabled }));

    // Write the on-device key first: it is the one the notification
    // handler consults, so this is what makes the toggle do anything at
    // all. The server write below is for cross-device sync (and for the
    // server-side filtering that will consume the same columns).
    await syncNotifPrefsToDevice({ [key]: enabled });

    if (userId) {
      try {
        await notificationService.updatePreferences(userId, { [key]: enabled });
      } catch {
        // Revert both sides together so they can't disagree.
        setCategoryPrefs((prev) => ({ ...prev, [key]: !enabled }));
        await syncNotifPrefsToDevice({ [key]: !enabled });
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

        {/* Privacy & safety */}
        <ProfileSection title={t('profile.section_privacy', { defaultValue: 'Privacidad y seguridad' })}>
          <ProfileRow
            icon="ban-outline"
            tint="#EF4444"
            label={t('block.blocked_users', { defaultValue: 'Usuarios bloqueados' })}
            onPress={() => router.push('/profile/blocked-users')}
            isLast
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
