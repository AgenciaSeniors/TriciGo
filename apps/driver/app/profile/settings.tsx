/**
 * DriverSettingsScreen — restructured for PR-B2.
 *
 * The previous file (544 LOC) listed nine independent sections —
 * Apariencia, Idioma, Sonidos, Modo nocturno, Zona preferida,
 * Modo silencioso, Notificaciones, Preferencias, Zona de peligro —
 * each with its own header + Card. Drivers had to scroll through a
 * flat wall of settings.
 *
 * PR-B2 collapses those nine sections into four semantic groups:
 *
 *   1. Pantalla    — display + language + night mode.
 *   2. Audio       — sounds + notifications (with category sub-toggles).
 *   3. Trabajo     — preferred zone, silent mode, auto-accept, SMS alerts.
 *   4. Cuenta      — account deletion (danger zone).
 *
 * Two reusable components were extracted:
 *   - `<SettingsRow>` — icon + title + optional subtitle + right-slot
 *     (Switch / value / pressable). Replaces the 8+ duplicated row
 *     blocks.
 *   - `<SettingsGroup>` — section header + children. Standardizes
 *     the four group bins.
 *
 * Behavior preserved verbatim:
 *   - All AsyncStorage keys + persistence logic unchanged.
 *   - Notification category sub-toggles still use the smaller (scale
 *     0.85) switch + tertiary icon styling for visual hierarchy.
 *   - Auto-accept eligibility check + Switch wiring identical.
 *   - SMS preference Switch wiring identical.
 *   - Delete-account flow (web confirm / iOS Alert.prompt / Android
 *     Alert.alert) identical.
 *
 * Microcopy unification stays out of scope; PR-B3 owns it.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Switch, Alert, useColorScheme, Platform, AppState } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { MenuRow } from '@tricigo/ui/MenuRow';
import { ProfileScreenHeader } from '@tricigo/ui/ProfileScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber, cubanLight, cubanDark } from '@tricigo/theme';
import { i18n } from '@tricigo/i18n';
import { notificationService, authService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { registerPushTokenForUser } from '@/hooks/useNotifications';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import DriverOverlay, { isDriverOverlayAvailable } from '../../modules/driver-overlay';

const NOTIF_PREF_KEY = '@tricigo/notifications_enabled';

const NOTIF_CATEGORIES = [
  { key: '@tricigo/notif_rides', icon: 'car-outline' as const, labelKey: 'profile.notif_trip_requests' },
  { key: '@tricigo/notif_chat', icon: 'chatbubble-outline' as const, labelKey: 'profile.notif_chat' },
  { key: '@tricigo/notif_wallet', icon: 'wallet-outline' as const, labelKey: 'profile.notif_wallet' },
  { key: '@tricigo/notif_promos', icon: 'gift-outline' as const, labelKey: 'profile.notif_promos' },
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

// Switch trackColor reused everywhere — extract once.
const SWITCH_TRACK = {
  false: midnightEmber.screen.line.default,
  true: midnightEmber.accent[500],
};

export default function DriverSettingsScreen() {
  const { t } = useTranslation('common');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  const userId = useAuthStore((s) => s.user?.id);

  // Existing state
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

  // "Display over other apps" (Android): auto-launch on ride offer + floating
  // bubble. Android gives no callback when the user returns from the system
  // Settings screen, so re-read the grant every time the app regains focus.
  const [overlayGranted, setOverlayGranted] = useState(() => DriverOverlay.canDrawOverlays());
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setOverlayGranted(DriverOverlay.canDrawOverlays());
    });
    return () => sub.remove();
  }, []);

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

  const toggleLanguage = () => {
    const cycle = ['es', 'en', 'pt'] as const;
    const idx = cycle.indexOf(currentLang as typeof cycle[number]);
    const next = cycle[(idx + 1) % cycle.length]!;
    i18n.changeLanguage(next);
    AsyncStorage.setItem('tricigo_language', next);
  };

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
    // left the server with no token — so no ride offers at all — until
    // the next cold start, while the switch showed "on".
    const result = await registerPushTokenForUser(userId);

    if (result === 'denied') {
      // The OS permission is off, so no offer can reach this driver.
      // Don't leave the switch claiming otherwise.
      setNotificationsEnabled(false);
      await AsyncStorage.setItem(NOTIF_PREF_KEY, 'false').catch(() => {});
      Alert.alert(
        t('profile.notif_permission_title', { defaultValue: 'Notificaciones bloqueadas' }),
        t('profile.notif_permission_msg', {
          defaultValue:
            'Tu teléfono tiene las notificaciones de TriciGo desactivadas. Sin ellas no vas a recibir ofertas de viaje. Actívalas desde los ajustes del sistema.',
        }),
      );
    }
    // 'error' is transient (network, Expo token service). Leave the
    // switch on: useNotificationSetup retries on the next foreground.
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
    const next = ZONE_OPTIONS[(idx + 1) % ZONE_OPTIONS.length]!.key;
    setPreferredZone(next);
    AsyncStorage.setItem(PREFERRED_ZONE_KEY, next);
  };

  const handleSilentTimerChange = () => {
    const idx = SILENT_TIMER_OPTIONS.findIndex((o) => o.minutes === silentModeTimer);
    const next = SILENT_TIMER_OPTIONS[(idx + 1) % SILENT_TIMER_OPTIONS.length]!.minutes;
    setSilentModeTimer(next);
    AsyncStorage.setItem(SILENT_MODE_TIMER_KEY, String(next));
  };

  const handleSmsToggle = async (enabled: boolean) => {
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
  };

  const handleDeleteAccount = () => {
    // BUG-Store-Readiness-Driver (DD1): invoke the shared `delete-account`
    // edge function (introduced in PR #160 for the client app). The edge
    // function:
    //   1. Anonymizes all non-CASCADE FK references to the user (rides,
    //      ratings, referrals, ledger entries, chat messages, etc.) by
    //      re-pointing them to the anonymous user (00000000-…-099).
    //   2. Best-effort cleanup of the user's avatar AND any KYC documents
    //      stored under `driver-documents/{user_id}/*` (carné, licencia,
    //      vehicle photo, selfie).
    //   3. Calls `auth.admin.deleteUser` which CASCADEs to public.users
    //      and the CASCADE-flagged children including `driver_profiles`.
    //
    // The previous implementation only did soft-delete of
    // `driver_profiles.is_active = false`, leaving KYC documents in
    // storage and auth.users intact — that was the inconsistency DD1
    // flagged by the audit (`app-store-review-notes.md` promised
    // "documents removed from storage" but it never happened).
    const performDelete = async () => {
      try {
        await authService.deleteAccount();
        router.replace('/(auth)/login');
      } catch {
        Alert.alert('Error', t('profile.delete_error', { defaultValue: 'No se pudo eliminar la cuenta.' }));
      }
    };

    if (Alert.prompt) {
      Alert.prompt(
        t('profile.delete_account_title', { defaultValue: 'Eliminar cuenta' }),
        t('profile.delete_account_confirm', {
          defaultValue:
            'Escribí ELIMINAR para confirmar. La acción es inmediata e irreversible: se borrarán tu cuenta, perfil y documentos KYC. El historial de viajes se anonimiza (no se borra) por requisitos de auditoría AML.',
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
              await performDelete();
            },
          },
        ],
        'plain-text',
      );
    } else {
      Alert.alert(
        t('profile.delete_account_title', { defaultValue: 'Eliminar cuenta' }),
        t('profile.delete_account_confirm_android', {
          defaultValue:
            '¿Estás seguro? Esta acción es inmediata e irreversible: se borrarán tu cuenta, perfil y documentos KYC. El historial de viajes se anonimiza por auditoría AML.',
        }),
        [
          { text: t('common.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
          {
            text: t('profile.delete', { defaultValue: 'Eliminar' }),
            style: 'destructive',
            onPress: performDelete,
          },
        ],
      );
    }
  };

  return (
    <Screen scroll bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'} padded>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
      <View className="pt-4 pb-12">
        <ProfileScreenHeader
          title={t('profile.settings_title')}
          onBack={() => router.back()}
          backAccessibilityLabel={t('common.back', { defaultValue: 'Volver' })}
        />

        {/* ── Group 1: Pantalla ────────────────────────────────────────── */}
        <SettingsGroup title={t('profile.section_display', { defaultValue: 'Pantalla' })}>
          {/* Language (uses MenuRow shared) */}
          <Card theme="light" variant="surface" padding="md" className="mb-3">
            <MenuRow
              icon="language-outline"
              label={t('profile.preferred_language')}
              value={LANG_LABELS[currentLang] ?? currentLang}
              iconBg="info"
              onPress={toggleLanguage}
              showBorder={false}
            />
          </Card>

          {/* Night mode */}
          <Card theme="light" variant="surface" padding="md">
            <SettingsRow
              icon="moon-outline"
              title={t('profile.night_mode_toggle', { defaultValue: 'Reducir brillo nocturno' })}
              subtitle={t('profile.night_mode_desc', { defaultValue: 'Reduce el brillo automáticamente de 10pm a 6am' })}
              right={
                <Switch
                  value={nightModeEnabled}
                  onValueChange={handleToggle(NIGHT_MODE_KEY, setNightModeEnabled)}
                  trackColor={SWITCH_TRACK}
                />
              }
            />
          </Card>
        </SettingsGroup>

        {/* ── Group 2: Audio ──────────────────────────────────────────── */}
        <SettingsGroup title={t('profile.section_audio', { defaultValue: 'Audio' })}>
          {/* Sounds — two switches in one card */}
          <Card theme="light" variant="surface" padding="md" className="mb-3">
            <SettingsRow
              icon="volume-high-outline"
              title={t('profile.sound_new_request', { defaultValue: 'Nueva solicitud' })}
              right={
                <Switch
                  value={soundNewRequest}
                  onValueChange={handleToggle(SOUND_NEW_REQUEST_KEY, setSoundNewRequest)}
                  trackColor={SWITCH_TRACK}
                />
              }
            />
            <SettingsRow
              icon="chatbubble-outline"
              title={t('profile.sound_message', { defaultValue: 'Mensaje recibido' })}
              right={
                <Switch
                  value={soundMessage}
                  onValueChange={handleToggle(SOUND_MESSAGE_KEY, setSoundMessage)}
                  trackColor={SWITCH_TRACK}
                />
              }
              withTopBorder
            />
          </Card>

          {/* Notifications + sub-categories */}
          <Card theme="light" variant="surface" padding="md">
            <SettingsRow
              icon="notifications-outline"
              title={t('profile.notifications_toggle')}
              right={
                <Switch
                  value={notificationsEnabled}
                  onValueChange={handleNotificationToggle}
                  trackColor={SWITCH_TRACK}
                  accessibilityLabel={t('profile.notifications_toggle')}
                />
              }
            />
            {notificationsEnabled && (
              <View
                style={{
                  marginTop: 12,
                  paddingTop: 12,
                  borderTopWidth: 1,
                  borderTopColor: midnightEmber.screen.line.default,
                }}
              >
                <Text variant="caption" color="secondary" className="mb-2">
                  {t('profile.notif_section_title')}
                </Text>
                {NOTIF_CATEGORIES.map((cat) => (
                  // V2 — row height enforced to ≥44pt (HIG). Previously
                  // py-2.5 + a 0.85-scaled Switch produced ~37pt rows which
                  // are easy to mis-tap, especially on cramped category
                  // lists like this one. Removed the scale so the Switch
                  // tracks render at full size.
                  <View
                    key={cat.key}
                    className="flex-row items-center justify-between py-3"
                    style={{ minHeight: 44 }}
                  >
                    <View className="flex-row items-center">
                      <Ionicons
                        name={cat.icon}
                        size={16}
                        color={midnightEmber.screen.text.tertiary}
                      />
                      <Text variant="bodySmall" color="primary" className="ml-2.5">
                        {t(cat.labelKey)}
                      </Text>
                    </View>
                    <Switch
                      value={categoryPrefs[cat.key] !== false}
                      onValueChange={(v) => handleCategoryToggle(cat.key, v)}
                      trackColor={SWITCH_TRACK}
                      accessibilityLabel={t(cat.labelKey)}
                    />
                  </View>
                ))}
              </View>
            )}
          </Card>

          {/* Overlay permission (Android): auto-launch on offer + floating bubble.
              Gated on module presence — on an old APK (OTA JS) the row would
              be a dead button (openOverlaySettings is a no-op there). */}
          {Platform.OS === 'android' && isDriverOverlayAvailable && (
            <Card theme="light" variant="surface" padding="md" className="mt-3">
              <MenuRow
                icon="albums-outline"
                label={t('overlay.settings_title', { defaultValue: 'Mostrar sobre otras apps' })}
                subtitle={
                  overlayGranted
                    ? t('overlay.settings_granted', { defaultValue: 'Activado: la app se abre sola al llegar un viaje' })
                    : t('overlay.settings_denied', { defaultValue: 'Actívalo para que la app se abra sola al llegar un viaje' })
                }
                value={overlayGranted ? t('overlay.settings_on', { defaultValue: 'Sí' }) : t('overlay.settings_off', { defaultValue: 'No' })}
                iconBg="warning"
                onPress={() => DriverOverlay.openOverlaySettings()}
                showBorder={false}
              />
            </Card>
          )}
        </SettingsGroup>

        {/* ── Group 3: Trabajo ────────────────────────────────────────── */}
        <SettingsGroup title={t('profile.section_work', { defaultValue: 'Trabajo' })}>
          {/* Preferred zone */}
          <Card theme="light" variant="surface" padding="md" className="mb-3">
            <MenuRow
              icon="location-outline"
              label={t('profile.preferred_zone', { defaultValue: 'Zona de trabajo' })}
              subtitle={t('profile.preferred_zone_desc', { defaultValue: 'Prioriza viajes en esta zona' })}
              value={t(
                ZONE_OPTIONS.find((z) => z.key === preferredZone)?.labelKey ?? 'profile.zone_any',
                { defaultValue: preferredZone },
              )}
              iconBg="warning"
              onPress={handleZoneChange}
              showBorder={false}
            />
          </Card>

          {/* Silent mode + nested duration */}
          <Card theme="light" variant="surface" padding="md" className="mb-3">
            <SettingsRow
              icon="volume-mute-outline"
              title={t('profile.silent_mode', { defaultValue: 'No recibir viajes' })}
              subtitle={t('profile.silent_mode_desc', { defaultValue: 'Pausa solicitudes sin desconectarte' })}
              right={
                <Switch
                  value={silentModeEnabled}
                  onValueChange={handleToggle(SILENT_MODE_KEY, setSilentModeEnabled)}
                  trackColor={SWITCH_TRACK}
                />
              }
            />
            {silentModeEnabled && (
              <View
                style={{
                  marginTop: 8,
                  paddingTop: 8,
                  borderTopWidth: 1,
                  borderTopColor: midnightEmber.screen.line.default,
                }}
              >
                <MenuRow
                  icon="timer-outline"
                  label={t('profile.silent_timer', { defaultValue: 'Duración' })}
                  value={t(
                    SILENT_TIMER_OPTIONS.find((o) => o.minutes === silentModeTimer)?.labelKey
                      ?? 'profile.silent_indefinite',
                    { defaultValue: 'Indefinido' },
                  )}
                  onPress={handleSilentTimerChange}
                  showBorder={false}
                />
              </View>
            )}
          </Card>

          {/* SMS Alerts */}
          <Card theme="light" variant="surface" padding="md">
            <SettingsRow
              icon="chatbubble-ellipses-outline"
              title={t('profile.notif_sms')}
              subtitle={t('profile.notif_sms_desc')}
              right={
                <Switch
                  value={smsEnabled}
                  disabled={smsLoading}
                  onValueChange={handleSmsToggle}
                  trackColor={SWITCH_TRACK}
                  accessibilityLabel={t('profile.notif_sms')}
                  // V3 — same as auto-accept above: mirror loading/disabled
                  // visual state in the a11y tree.
                  accessibilityState={{
                    checked: smsEnabled,
                    disabled: smsLoading,
                  }}
                />
              }
            />
          </Card>
        </SettingsGroup>

        {/* ── Group: Privacidad y seguridad ───────────────────────────── */}
        <SettingsGroup title={t('profile.section_privacy', { defaultValue: 'Privacidad y seguridad' })}>
          <Card theme="light" variant="surface" padding="md">
            <MenuRow
              icon="ban-outline"
              label={t('block.blocked_users', { defaultValue: 'Usuarios bloqueados' })}
              iconBg="error"
              onPress={() => router.push('/profile/blocked-users')}
              showBorder={false}
            />
          </Card>
        </SettingsGroup>

        {/* ── Group 4: Cuenta ─────────────────────────────────────────── */}
        <SettingsGroup title={t('profile.section_account', { defaultValue: 'Cuenta' })}>
          <Card theme="light" variant="surface" padding="md">
            <Text variant="bodySmall" color="secondary" className="mb-3">
              {t('profile.delete_account_desc', {
                defaultValue: 'Eliminar tu cuenta es permanente. Se perderan todos tus datos, historial de viajes y balance.',
              })}
            </Text>
            {/* V3 — destructive action gets explicit press feedback. The
                  current visual is already strong (danger-tinted bg + border
                  + trash icon), but pressing gave no immediate ack. The
                  opacity drop on press completes the feedback loop without
                  amplifying the visual weight (we don't want the delete
                  CTA to be MORE attention-grabbing than the trip view's
                  primary CTAs). */}
            <Pressable
              onPress={handleDeleteAccount}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                paddingVertical: 12,
                borderRadius: midnightEmber.radius.input,
                backgroundColor: `${midnightEmber.state.danger}1F`,
                borderWidth: 1,
                borderColor: `${midnightEmber.state.danger}4D`,
                minHeight: 48,
                opacity: pressed ? 0.7 : 1,
              })}
              android_ripple={{ color: `${midnightEmber.state.danger}26` }}
              accessibilityRole="button"
              accessibilityLabel={t('profile.delete_account', { defaultValue: 'Eliminar cuenta' })}
            >
              <Ionicons name="trash-outline" size={18} color={midnightEmber.state.danger} />
              <Text
                variant="body"
                style={{
                  color: midnightEmber.state.danger,
                  marginLeft: 8,
                  fontWeight: '600',
                }}
              >
                {t('profile.delete_account', { defaultValue: 'Eliminar cuenta' })}
              </Text>
            </Pressable>
          </Card>
        </SettingsGroup>
      </View>
      </View>
    </Screen>
  );
}
