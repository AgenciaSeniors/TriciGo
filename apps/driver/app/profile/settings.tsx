import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Switch, Alert, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { i18n } from '@tricigo/i18n';
import { notificationService, driverService, authService, getSupabaseClient } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
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
  const profile = useDriverStore((s) => s.profile);
  const [autoAcceptEnabled, setAutoAcceptEnabled] = useState(false);
  const [autoAcceptEligible, setAutoAcceptEligible] = useState(false);
  const [autoAcceptLoading, setAutoAcceptLoading] = useState(false);
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

    if (userId) {
      notificationService.getSmsPreference(userId).then(setSmsEnabled).catch(() => {});
    }
  }, [userId]);

  useEffect(() => {
    if (!profile?.id) return;
    setAutoAcceptEnabled(!!profile.auto_accept_enabled);
    driverService.isEligibleForAutoAccept(profile.id).then(setAutoAcceptEligible).catch(() => {});
  }, [profile?.id]);

  const toggleLanguage = () => {
    const next = currentLang === 'es' ? 'en' : currentLang === 'en' ? 'pt' : 'es';
    i18n.changeLanguage(next);
    AsyncStorage.setItem('tricigo_language', next);
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

  const LANG_LABELS: Record<string, string> = { es: 'Español', en: 'English', pt: 'Português' };

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        {/* Header */}
        <View className="flex-row items-center mb-6">
          <Pressable
            onPress={() => router.back()}
            className="mr-3 w-10 h-10 rounded-xl bg-[#252540] items-center justify-center"
            accessibilityRole="button"
            accessibilityLabel={t('common.back', { defaultValue: 'Volver' })}
          >
            <Ionicons name="arrow-back" size={20} color={colors.neutral[50]} />
          </Pressable>
          <Text variant="h3" color="inverse">{t('profile.settings_title')}</Text>
        </View>

        {/* ── Language ── */}
        <Text variant="label" color="secondary" className="mb-2 ml-1">
          {t('profile.section_language', { defaultValue: 'Idioma' })}
        </Text>
        <Card variant="surface" padding="md" className="mb-5">
          <Pressable
            onPress={toggleLanguage}
            className="flex-row items-center justify-between min-h-[48px]"
            accessibilityRole="button"
            accessibilityLabel={`${t('profile.preferred_language')}: ${LANG_LABELS[currentLang] ?? currentLang}`}
          >
            <View className="flex-row items-center">
              <View className="w-9 h-9 rounded-xl bg-[#252540] items-center justify-center mr-3">
                <Ionicons name="language-outline" size={18} color={colors.brand.orange} />
              </View>
              <Text variant="body" color="inverse">{t('profile.preferred_language')}</Text>
            </View>
            <View className="flex-row items-center">
              <Text variant="bodySmall" color="accent" className="mr-1">
                {LANG_LABELS[currentLang] ?? currentLang}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={colors.neutral[500]} />
            </View>
          </Pressable>
        </Card>

        {/* ── Notifications ── */}
        <Text variant="label" color="secondary" className="mb-2 ml-1">
          {t('profile.section_notifications', { defaultValue: 'Notificaciones' })}
        </Text>
        <Card variant="surface" padding="md" className="mb-5">
          <View className="flex-row items-center justify-between min-h-[48px]">
            <View className="flex-row items-center">
              <View className="w-9 h-9 rounded-xl bg-[#252540] items-center justify-center mr-3">
                <Ionicons name="notifications-outline" size={18} color={colors.brand.orange} />
              </View>
              <Text variant="body" color="inverse">{t('profile.notifications_toggle')}</Text>
            </View>
            <Switch
              value={notificationsEnabled}
              onValueChange={handleNotificationToggle}
              trackColor={{ false: '#252540', true: colors.brand.orange }}
              accessibilityLabel={t('profile.notifications_toggle')}
            />
          </View>

          {notificationsEnabled && (
            <View className="mt-3 pt-3 border-t border-white/6">
              <Text variant="caption" color="secondary" className="mb-2">
                {t('profile.notif_section_title')}
              </Text>
              {NOTIF_CATEGORIES.map((cat) => (
                <View
                  key={cat.key}
                  className="flex-row items-center justify-between py-2.5"
                >
                  <View className="flex-row items-center">
                    <Ionicons name={cat.icon} size={16} color={colors.neutral[500]} />
                    <Text variant="bodySmall" color="inverse" className="ml-2.5">
                      {t(cat.labelKey)}
                    </Text>
                  </View>
                  <Switch
                    value={categoryPrefs[cat.key] !== false}
                    onValueChange={(v) => handleCategoryToggle(cat.key, v)}
                    trackColor={{ false: '#252540', true: colors.brand.orange }}
                    style={{ transform: [{ scale: 0.85 }] }}
                    accessibilityLabel={t(cat.labelKey)}
                  />
                </View>
              ))}
            </View>
          )}
        </Card>

        {/* ── Preferences ── */}
        <Text variant="label" color="secondary" className="mb-2 ml-1">
          {t('profile.section_preferences', { defaultValue: 'Preferencias' })}
        </Text>

        {/* Auto-accept rides */}
        <Card variant="surface" padding="md" className="mb-3">
          <View className="flex-row items-center justify-between min-h-[48px]">
            <View className="flex-row items-center flex-1 mr-3">
              <View className="w-9 h-9 rounded-xl bg-[#252540] items-center justify-center mr-3">
                <Ionicons name="flash-outline" size={18} color={colors.brand.orange} />
              </View>
              <View className="flex-1">
                <Text variant="body" color="inverse">
                  {t('profile.auto_accept_toggle', { defaultValue: 'Auto-aceptar viajes' })}
                </Text>
                {autoAcceptEligible ? (
                  <Text variant="caption" color="secondary" className="mt-0.5">
                    {autoAcceptEnabled
                      ? t('profile.auto_accept_on_desc', { defaultValue: 'Aceptación automática. 5s para cancelar.' })
                      : t('profile.auto_accept_off_desc', { defaultValue: 'Aceptación manual requerida.' })}
                  </Text>
                ) : (
                  <Text variant="caption" color="secondary" className="mt-0.5">
                    {t('profile.auto_accept_not_eligible', { defaultValue: 'Disponible con 50+ viajes y 4.5+ rating' })}
                  </Text>
                )}
              </View>
            </View>
            <Switch
              value={autoAcceptEnabled}
              disabled={!autoAcceptEligible || autoAcceptLoading}
              onValueChange={async (enabled) => {
                if (!profile?.id) return;
                setAutoAcceptEnabled(enabled);
                setAutoAcceptLoading(true);
                try {
                  await driverService.setAutoAccept(profile.id, enabled);
                } catch {
                  setAutoAcceptEnabled(!enabled);
                } finally {
                  setAutoAcceptLoading(false);
                }
              }}
              trackColor={{ false: '#252540', true: colors.brand.orange }}
              accessibilityLabel={t('profile.auto_accept_toggle', { defaultValue: 'Auto-aceptar viajes' })}
            />
          </View>
        </Card>

        {/* SMS Alerts */}
        <Card variant="surface" padding="md" className="mb-8">
          <View className="flex-row items-center justify-between min-h-[48px]">
            <View className="flex-row items-center flex-1 mr-3">
              <View className="w-9 h-9 rounded-xl bg-[#252540] items-center justify-center mr-3">
                <Ionicons name="chatbubble-ellipses-outline" size={18} color={colors.brand.orange} />
              </View>
              <View className="flex-1">
                <Text variant="body" color="inverse">{t('profile.notif_sms')}</Text>
                <Text variant="caption" color="secondary" className="mt-0.5">
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
              trackColor={{ false: '#252540', true: colors.brand.orange }}
              accessibilityLabel={t('profile.notif_sms')}
            />
          </View>
        </Card>

        {/* ── Delete Account ── */}
        <View className="mt-6">
          <Text variant="h4" color="inverse" className="mb-3 px-1">
            {t('profile.danger_zone', { defaultValue: 'Zona de peligro' })}
          </Text>
          <Card variant="surface" padding="md">
            <Text variant="bodySmall" color="secondary" className="mb-3">
              {t('profile.delete_account_desc', {
                defaultValue: 'Eliminar tu cuenta es permanente. Se perderan todos tus datos, historial de viajes y balance.',
              })}
            </Text>
            <Pressable
              onPress={() => {
                Alert.prompt
                  ? Alert.prompt(
                      t('profile.delete_account_title', { defaultValue: 'Eliminar cuenta' }),
                      t('profile.delete_account_confirm', {
                        defaultValue: 'Escribe ELIMINAR para confirmar la eliminacion de tu cuenta.',
                      }),
                      [
                        { text: t('common.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
                        {
                          text: t('profile.delete', { defaultValue: 'Eliminar' }),
                          style: 'destructive',
                          onPress: async (text?: string) => {
                            if (text?.toUpperCase() !== 'ELIMINAR') {
                              Alert.alert('Error', t('profile.delete_mismatch', { defaultValue: 'Texto incorrecto.' }));
                              return;
                            }
                            try {
                              if (userId) {
                                const supabase = getSupabaseClient();
                                await supabase
                                  .from('driver_profiles')
                                  .update({ is_active: false, deactivated_at: new Date().toISOString() })
                                  .eq('user_id', userId);
                              }
                              await authService.signOut();
                              router.replace('/(auth)/login');
                            } catch {
                              Alert.alert('Error', t('profile.delete_error', { defaultValue: 'No se pudo eliminar la cuenta.' }));
                            }
                          },
                        },
                      ],
                      'plain-text',
                    )
                  : // Android fallback (Alert.prompt is iOS-only)
                    Alert.alert(
                      t('profile.delete_account_title', { defaultValue: 'Eliminar cuenta' }),
                      t('profile.delete_account_confirm_android', {
                        defaultValue: '¿Estas seguro de que deseas eliminar tu cuenta? Esta accion es irreversible.',
                      }),
                      [
                        { text: t('common.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
                        {
                          text: t('profile.delete', { defaultValue: 'Eliminar' }),
                          style: 'destructive',
                          onPress: async () => {
                            try {
                              if (userId) {
                                const supabase = getSupabaseClient();
                                await supabase
                                  .from('driver_profiles')
                                  .update({ is_active: false, deactivated_at: new Date().toISOString() })
                                  .eq('user_id', userId);
                              }
                              await authService.signOut();
                              router.replace('/(auth)/login');
                            } catch {
                              Alert.alert('Error', t('profile.delete_error', { defaultValue: 'No se pudo eliminar la cuenta.' }));
                            }
                          },
                        },
                      ],
                    );
              }}
              className="flex-row items-center justify-center py-3 rounded-xl"
              style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)', minHeight: 48 }}
              accessibilityRole="button"
              accessibilityLabel={t('profile.delete_account', { defaultValue: 'Eliminar cuenta' })}
            >
              <Ionicons name="trash-outline" size={18} color="#ef4444" />
              <Text variant="body" style={{ color: '#ef4444', marginLeft: 8, fontWeight: '600' }}>
                {t('profile.delete_account', { defaultValue: 'Eliminar cuenta' })}
              </Text>
            </Pressable>
          </Card>
        </View>
      </View>
    </Screen>
  );
}
