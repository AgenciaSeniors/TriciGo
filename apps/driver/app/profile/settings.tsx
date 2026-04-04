import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Switch, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { colors, driverDarkColors } from '@tricigo/theme';
import type { ThemeMode } from '@tricigo/theme';
import { i18n } from '@tricigo/i18n';
import { notificationService, driverService, authService, getSupabaseClient } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useThemeStore, setThemeMode } from '@/stores/theme.store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

const NOTIF_PREF_KEY = '@tricigo/notifications_enabled';

const NOTIF_CATEGORIES = [
  { key: '@tricigo/notif_rides', icon: 'car-outline' as const, labelKey: 'profile.notif_trip_requests' },
  { key: '@tricigo/notif_chat', icon: 'chatbubble-outline' as const, labelKey: 'profile.notif_chat' },
  { key: '@tricigo/notif_wallet', icon: 'wallet-outline' as const, labelKey: 'profile.notif_wallet' },
  { key: '@tricigo/notif_promos', icon: 'gift-outline' as const, labelKey: 'profile.notif_promos' },
];

const THEME_OPTIONS: { value: ThemeMode; labelKey: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: 'light', labelKey: 'profile.theme_light', icon: 'sunny-outline' },
  { value: 'dark', labelKey: 'profile.theme_dark', icon: 'moon-outline' },
  { value: 'system', labelKey: 'profile.theme_system', icon: 'phone-portrait-outline' },
];

const LANG_LABELS: Record<string, string> = { es: 'Español', en: 'English', pt: 'Português' };

// AsyncStorage keys for new settings
const SOUND_NEW_REQUEST_KEY = '@tricigo/sound_new_request';
const SOUND_MESSAGE_KEY = '@tricigo/sound_message';
const NIGHT_MODE_KEY = '@tricigo/night_mode';
const PREFERRED_ZONE_KEY = '@tricigo/preferred_zone';
const SILENT_MODE_KEY = '@tricigo/silent_mode';
const SILENT_MODE_TIMER_KEY = '@tricigo/silent_mode_timer';

const ZONE_OPTIONS = [
  { key: 'any', labelKey: 'profile.zone_any' },
  { key: 'centro', labelKey: 'profile.zone_centro' },
  { key: 'vedado', labelKey: 'profile.zone_vedado' },
  { key: 'miramar', labelKey: 'profile.zone_miramar' },
  { key: 'habana_vieja', labelKey: 'profile.zone_habana_vieja' },
  { key: 'airport', labelKey: 'profile.zone_airport' },
];

const SILENT_TIMER_OPTIONS = [
  { minutes: 0, labelKey: 'profile.silent_indefinite' },
  { minutes: 30, labelKey: 'profile.silent_30min' },
  { minutes: 60, labelKey: 'profile.silent_1h' },
  { minutes: 120, labelKey: 'profile.silent_2h' },
];

export default function DriverSettingsScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const profile = useDriverStore((s) => s.profile);
  const themeMode = useThemeStore((s) => s.mode);

  // Existing state
  const [autoAcceptEnabled, setAutoAcceptEnabled] = useState(false);
  const [autoAcceptEligible, setAutoAcceptEligible] = useState(false);
  const [autoAcceptLoading, setAutoAcceptLoading] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [categoryPrefs, setCategoryPrefs] = useState<Record<string, boolean>>({});
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsLoading, setSmsLoading] = useState(false);
  const currentLang = i18n.language ?? 'es';

  // New settings state
  const [soundNewRequest, setSoundNewRequest] = useState(true);
  const [soundMessage, setSoundMessage] = useState(true);
  const [nightModeEnabled, setNightModeEnabled] = useState(false);
  const [preferredZone, setPreferredZone] = useState('any');
  const [silentModeEnabled, setSilentModeEnabled] = useState(false);
  const [silentModeTimer, setSilentModeTimer] = useState(0);

  useEffect(() => {
    // Load existing preferences
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

    // Load new settings
    AsyncStorage.getItem(SOUND_NEW_REQUEST_KEY).then((v) => { if (v !== null) setSoundNewRequest(v === 'true'); }).catch(() => {});
    AsyncStorage.getItem(SOUND_MESSAGE_KEY).then((v) => { if (v !== null) setSoundMessage(v === 'true'); }).catch(() => {});
    AsyncStorage.getItem(NIGHT_MODE_KEY).then((v) => { if (v !== null) setNightModeEnabled(v === 'true'); }).catch(() => {});
    AsyncStorage.getItem(PREFERRED_ZONE_KEY).then((v) => { if (v !== null) setPreferredZone(v); }).catch(() => {});
    AsyncStorage.getItem(SILENT_MODE_KEY).then((v) => { if (v !== null) setSilentModeEnabled(v === 'true'); }).catch(() => {});
    AsyncStorage.getItem(SILENT_MODE_TIMER_KEY).then((v) => { if (v !== null) setSilentModeTimer(Number(v)); }).catch(() => {});
  }, [userId]);

  useEffect(() => {
    if (!profile?.id) return;
    setAutoAcceptEnabled(!!profile.auto_accept_enabled);
    driverService.isEligibleForAutoAccept(profile.id).then(setAutoAcceptEligible).catch(() => {});
  }, [profile?.id]);

  const toggleLanguage = () => {
    const cycle = ['es', 'en', 'pt'] as const;
    const idx = cycle.indexOf(currentLang as typeof cycle[number]);
    const next = cycle[(idx + 1) % cycle.length];
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

  const handleToggle = (key: string, setter: (v: boolean) => void) => async (enabled: boolean) => {
    setter(enabled);
    await AsyncStorage.setItem(key, String(enabled)).catch(() => {});
  };

  const handleZoneChange = () => {
    const idx = ZONE_OPTIONS.findIndex((z) => z.key === preferredZone);
    const next = ZONE_OPTIONS[(idx + 1) % ZONE_OPTIONS.length].key;
    setPreferredZone(next);
    AsyncStorage.setItem(PREFERRED_ZONE_KEY, next);
  };

  const handleSilentTimerChange = () => {
    const idx = SILENT_TIMER_OPTIONS.findIndex((o) => o.minutes === silentModeTimer);
    const next = SILENT_TIMER_OPTIONS[(idx + 1) % SILENT_TIMER_OPTIONS.length].minutes;
    setSilentModeTimer(next);
    AsyncStorage.setItem(SILENT_MODE_TIMER_KEY, String(next));
  };

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4 pb-12">
        {/* Header */}
        <View className="flex-row items-center mb-6">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            className="mr-3 w-11 h-11 rounded-xl items-center justify-center"
            style={{ backgroundColor: driverDarkColors.hover }}
            accessibilityRole="button"
            accessibilityLabel={t('common.back', { defaultValue: 'Volver' })}
          >
            <Ionicons name="arrow-back" size={20} color={colors.neutral[50]} />
          </Pressable>
          <Text variant="h3" color="inverse">{t('profile.settings_title')}</Text>
        </View>

        {/* ── Appearance ── */}
        <Text variant="label" color="secondary" className="mb-2 ml-1">
          {t('profile.section_appearance', { defaultValue: 'Apariencia' })}
        </Text>
        <Card variant="surface" padding="md" className="mb-5">
          <View className="flex-row items-center mb-3">
            <View className="w-9 h-9 rounded-xl bg-[#1e1e1e] items-center justify-center mr-3">
              <Ionicons name="color-palette-outline" size={18} color={colors.brand.orange} />
            </View>
            <Text variant="body" color="inverse">{t('profile.appearance', { defaultValue: 'Modo de pantalla' })}</Text>
          </View>
          <View className="flex-row rounded-xl overflow-hidden border border-[#2a2a2a]">
            {THEME_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => setThemeMode(option.value)}
                className={`flex-1 py-3 items-center flex-row justify-center ${
                  themeMode === option.value ? 'bg-primary-500' : 'bg-[#141414]'
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
                  {t(option.labelKey, { defaultValue: option.value })}
                </Text>
              </Pressable>
            ))}
          </View>
        </Card>

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
              <View className="w-9 h-9 rounded-xl bg-[#1e1e1e] items-center justify-center mr-3">
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

        {/* ── Sounds ── */}
        <Text variant="label" color="secondary" className="mb-2 ml-1">
          {t('profile.section_sounds', { defaultValue: 'Sonidos' })}
        </Text>
        <Card variant="surface" padding="md" className="mb-5">
          <View className="flex-row items-center justify-between min-h-[48px]">
            <View className="flex-row items-center">
              <View className="w-9 h-9 rounded-xl bg-[#1e1e1e] items-center justify-center mr-3">
                <Ionicons name="volume-high-outline" size={18} color={colors.brand.orange} />
              </View>
              <Text variant="body" color="inverse">
                {t('profile.sound_new_request', { defaultValue: 'Nueva solicitud' })}
              </Text>
            </View>
            <Switch
              value={soundNewRequest}
              onValueChange={handleToggle(SOUND_NEW_REQUEST_KEY, setSoundNewRequest)}
              trackColor={{ false: driverDarkColors.hover, true: colors.brand.orange }}
            />
          </View>
          <View className="flex-row items-center justify-between min-h-[48px] mt-1 pt-2 border-t border-[#2a2a2a]">
            <View className="flex-row items-center">
              <View className="w-9 h-9 rounded-xl bg-[#1e1e1e] items-center justify-center mr-3">
                <Ionicons name="chatbubble-outline" size={18} color={colors.brand.orange} />
              </View>
              <Text variant="body" color="inverse">
                {t('profile.sound_message', { defaultValue: 'Mensaje recibido' })}
              </Text>
            </View>
            <Switch
              value={soundMessage}
              onValueChange={handleToggle(SOUND_MESSAGE_KEY, setSoundMessage)}
              trackColor={{ false: driverDarkColors.hover, true: colors.brand.orange }}
            />
          </View>
        </Card>

        {/* ── Night Mode ── */}
        <Text variant="label" color="secondary" className="mb-2 ml-1">
          {t('profile.section_night_mode', { defaultValue: 'Modo nocturno' })}
        </Text>
        <Card variant="surface" padding="md" className="mb-5">
          <View className="flex-row items-center justify-between min-h-[48px]">
            <View className="flex-row items-center flex-1 mr-3">
              <View className="w-9 h-9 rounded-xl bg-[#1e1e1e] items-center justify-center mr-3">
                <Ionicons name="moon-outline" size={18} color={colors.brand.orange} />
              </View>
              <View className="flex-1">
                <Text variant="body" color="inverse">
                  {t('profile.night_mode_toggle', { defaultValue: 'Reducir brillo nocturno' })}
                </Text>
                <Text variant="caption" color="secondary" className="mt-0.5">
                  {t('profile.night_mode_desc', { defaultValue: 'Reduce el brillo automáticamente de 10pm a 6am' })}
                </Text>
              </View>
            </View>
            <Switch
              value={nightModeEnabled}
              onValueChange={handleToggle(NIGHT_MODE_KEY, setNightModeEnabled)}
              trackColor={{ false: driverDarkColors.hover, true: colors.brand.orange }}
            />
          </View>
        </Card>

        {/* ── Preferred Zone ── */}
        <Text variant="label" color="secondary" className="mb-2 ml-1">
          {t('profile.section_zone', { defaultValue: 'Zona preferida' })}
        </Text>
        <Card variant="surface" padding="md" className="mb-5">
          <Pressable
            onPress={handleZoneChange}
            className="flex-row items-center justify-between min-h-[48px]"
            accessibilityRole="button"
          >
            <View className="flex-row items-center flex-1 mr-3">
              <View className="w-9 h-9 rounded-xl bg-[#1e1e1e] items-center justify-center mr-3">
                <Ionicons name="location-outline" size={18} color={colors.brand.orange} />
              </View>
              <View className="flex-1">
                <Text variant="body" color="inverse">
                  {t('profile.preferred_zone', { defaultValue: 'Zona de trabajo' })}
                </Text>
                <Text variant="caption" color="secondary" className="mt-0.5">
                  {t('profile.preferred_zone_desc', { defaultValue: 'Prioriza viajes en esta zona' })}
                </Text>
              </View>
            </View>
            <View className="flex-row items-center">
              <Text variant="bodySmall" color="accent" className="mr-1">
                {t(ZONE_OPTIONS.find((z) => z.key === preferredZone)?.labelKey ?? 'profile.zone_any', { defaultValue: preferredZone })}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={colors.neutral[500]} />
            </View>
          </Pressable>
        </Card>

        {/* ── Silent Mode ── */}
        <Text variant="label" color="secondary" className="mb-2 ml-1">
          {t('profile.section_silent', { defaultValue: 'Modo silencioso' })}
        </Text>
        <Card variant="surface" padding="md" className="mb-5">
          <View className="flex-row items-center justify-between min-h-[48px]">
            <View className="flex-row items-center flex-1 mr-3">
              <View className="w-9 h-9 rounded-xl bg-[#1e1e1e] items-center justify-center mr-3">
                <Ionicons name="volume-mute-outline" size={18} color={colors.brand.orange} />
              </View>
              <View className="flex-1">
                <Text variant="body" color="inverse">
                  {t('profile.silent_mode', { defaultValue: 'No recibir viajes' })}
                </Text>
                <Text variant="caption" color="secondary" className="mt-0.5">
                  {t('profile.silent_mode_desc', { defaultValue: 'Pausa solicitudes sin desconectarte' })}
                </Text>
              </View>
            </View>
            <Switch
              value={silentModeEnabled}
              onValueChange={handleToggle(SILENT_MODE_KEY, setSilentModeEnabled)}
              trackColor={{ false: driverDarkColors.hover, true: colors.brand.orange }}
            />
          </View>
          {silentModeEnabled && (
            <Pressable
              onPress={handleSilentTimerChange}
              className="flex-row items-center justify-between mt-2 pt-2 border-t border-[#2a2a2a] min-h-[40px]"
            >
              <View className="flex-row items-center">
                <Ionicons name="timer-outline" size={16} color={colors.neutral[500]} />
                <Text variant="bodySmall" color="inverse" className="ml-2">
                  {t('profile.silent_timer', { defaultValue: 'Duración' })}
                </Text>
              </View>
              <View className="flex-row items-center">
                <Text variant="bodySmall" color="accent" className="mr-1">
                  {t(SILENT_TIMER_OPTIONS.find((o) => o.minutes === silentModeTimer)?.labelKey ?? 'profile.silent_indefinite', { defaultValue: 'Indefinido' })}
                </Text>
                <Ionicons name="chevron-forward" size={14} color={colors.neutral[500]} />
              </View>
            </Pressable>
          )}
        </Card>

        {/* ── Notifications ── */}
        <Text variant="label" color="secondary" className="mb-2 ml-1">
          {t('profile.section_notifications', { defaultValue: 'Notificaciones' })}
        </Text>
        <Card variant="surface" padding="md" className="mb-5">
          <View className="flex-row items-center justify-between min-h-[48px]">
            <View className="flex-row items-center">
              <View className="w-9 h-9 rounded-xl bg-[#1e1e1e] items-center justify-center mr-3">
                <Ionicons name="notifications-outline" size={18} color={colors.brand.orange} />
              </View>
              <Text variant="body" color="inverse">{t('profile.notifications_toggle')}</Text>
            </View>
            <Switch
              value={notificationsEnabled}
              onValueChange={handleNotificationToggle}
              trackColor={{ false: driverDarkColors.hover, true: colors.brand.orange }}
              accessibilityLabel={t('profile.notifications_toggle')}
            />
          </View>

          {notificationsEnabled && (
            <View className="mt-3 pt-3 border-t border-[#2a2a2a]">
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
                    trackColor={{ false: driverDarkColors.hover, true: colors.brand.orange }}
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
              <View className="w-9 h-9 rounded-xl bg-[#1e1e1e] items-center justify-center mr-3">
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
              trackColor={{ false: driverDarkColors.hover, true: colors.brand.orange }}
              accessibilityLabel={t('profile.auto_accept_toggle', { defaultValue: 'Auto-aceptar viajes' })}
            />
          </View>
        </Card>

        {/* SMS Alerts */}
        <Card variant="surface" padding="md" className="mb-8">
          <View className="flex-row items-center justify-between min-h-[48px]">
            <View className="flex-row items-center flex-1 mr-3">
              <View className="w-9 h-9 rounded-xl bg-[#1e1e1e] items-center justify-center mr-3">
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
              trackColor={{ false: driverDarkColors.hover, true: colors.brand.orange }}
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
                  : Alert.alert(
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
