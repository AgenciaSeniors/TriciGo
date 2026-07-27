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
import React, { useState, useEffect, useCallback, useRef } from 'react';
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
import { notificationService, authService, driverService } from '@tricigo/api';
import { logger } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { registerPushTokenForUser } from '@/hooks/useNotifications';
import { useVoiceGuidancePref } from '@/hooks/useVoiceGuidancePref';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import DriverOverlay, { isDriverOverlayAvailable } from '../../modules/driver-overlay';

const NOTIF_PREF_KEY = '@tricigo/notifications_enabled';

/**
 * Each category toggle, with BOTH the on-device key that suppresses a
 * foreground notification and the `notification_preferences` column that
 * stops the server from sending it at all.
 *
 * The server column was missing here until now. The driver app only ever
 * wrote AsyncStorage, so `notification_preferences` had no row for a
 * driver-only account — and `send-push` (which filters on that table since
 * #865) treats a missing row as "never opted out" and delivers. A driver who
 * turned Chat off still got the push whenever the app was backgrounded or
 * killed, which is the only case that matters. The client and the web wrote
 * the table all along; the driver was the odd one out.
 */
const NOTIF_CATEGORIES = [
  { key: '@tricigo/notif_rides', serverPref: 'ride_updates', icon: 'car-outline' as const, labelKey: 'profile.notif_trip_requests' },
  { key: '@tricigo/notif_chat', serverPref: 'chat_messages', icon: 'chatbubble-outline' as const, labelKey: 'profile.notif_chat' },
  { key: '@tricigo/notif_wallet', serverPref: 'payment_updates', icon: 'wallet-outline' as const, labelKey: 'profile.notif_wallet' },
  { key: '@tricigo/notif_promos', serverPref: 'promotions', icon: 'gift-outline' as const, labelKey: 'profile.notif_promos' },
] as const;

type ServerPrefColumn = (typeof NOTIF_CATEGORIES)[number]['serverPref'];

const SERVER_PREF_BY_LOCAL_KEY: Record<string, ServerPrefColumn> = Object.fromEntries(
  NOTIF_CATEGORIES.map((c) => [c.key, c.serverPref]),
);

const LANG_LABELS: Record<string, string> = { es: 'Español', en: 'English', pt: 'Português' };

/**
 * Max-distance options, in km, for the "Distancia máxima" row.
 *
 * `null` means no limit and CLEARS the key — `find_best_drivers` guards
 * the check with `IS NULL`, so an absent key is the only way to express
 * "no restriction". Storing 0 would filter the driver out of every ride.
 *
 * The values stay at or below the dispatch radius (5 km by default);
 * anything larger would be a no-op the driver could not tell apart from
 * a working setting.
 */
const MAX_DISTANCE_OPTIONS: (number | null)[] = [null, 1, 2, 3, 5];

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
  // Bumped on every category toggle; a load that started before the bump
  // discards its result instead of overwriting the user's choice.
  const prefsGenerationRef = useRef(0);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [categoryPrefs, setCategoryPrefs] = useState<Record<string, boolean>>({});
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsLoading, setSmsLoading] = useState(false);
  const currentLang = i18n.language ?? 'es';

  // Matching preferences — these live in `driver_profiles.preferences`
  // and are honored by `find_best_drivers`. They replace a set of
  // switches (night mode, offer sounds, work zone, "no recibir viajes")
  // that wrote to AsyncStorage and had no consumer anywhere.
  const driverProfileId = useDriverStore((s) => s.profile?.id);
  // Same persisted key the trip navigation reads, so the two stay in
  // agreement. (A trip view already mounted keeps its own copy until
  // remount — acceptable, since you cannot be navigating and sitting in
  // Settings at the same moment.)
  const [voiceGuidanceEnabled, setVoiceGuidanceEnabled] = useVoiceGuidancePref();
  const [maxDistanceKm, setMaxDistanceKm] = useState<number | null>(null);
  const [acceptsLongTrips, setAcceptsLongTrips] = useState(true);
  const [prefsSaving, setPrefsSaving] = useState(false);

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

    const generation = prefsGenerationRef.current;

    // Paint from the on-device values first — they're local and immediate.
    Promise.all(
      NOTIF_CATEGORIES.map(async (cat) => {
        const val = await AsyncStorage.getItem(cat.key).catch(() => null);
        return [cat.key, val !== 'false'] as const;
      }),
    ).then((results) => {
      if (prefsGenerationRef.current !== generation) return;
      setCategoryPrefs(Object.fromEntries(results));
    });

    if (userId) {
      notificationService.getSmsPreference(userId).then(setSmsEnabled).catch(() => {});

      // Also the source of truth for the server-side filter. Calling this is
      // what CREATES the row (the RPC is an upsert); `updatePreferences` is a
      // plain UPDATE and would fail on a driver who never had one.
      notificationService.getPreferences(userId).then((prefs) => {
        if (!prefs) return;
        if (prefsGenerationRef.current !== generation) return;
        const fromServer = Object.fromEntries(
          NOTIF_CATEGORIES.map((cat) => [cat.key, prefs[cat.serverPref] !== false]),
        );
        setCategoryPrefs(fromServer);
        // Mirror down: the notification handler only reads AsyncStorage.
        Promise.all(
          NOTIF_CATEGORIES.map((cat) =>
            AsyncStorage.setItem(cat.key, String(prefs[cat.serverPref] !== false)).catch(() => {}),
          ),
        );
      }).catch(() => {
        // Offline: the device values above stay in force.
      });
    }
  }, [userId]);

  // Matching preferences come from the profile already in the store —
  // no extra fetch. An absent key means "no restriction", which is
  // exactly how the matching engine reads it.
  useEffect(() => {
    const prefs = useDriverStore.getState().profile?.preferences;
    setMaxDistanceKm(typeof prefs?.max_distance_km === 'number' ? prefs.max_distance_km : null);
    setAcceptsLongTrips(prefs?.accepts_long_trips !== false);
  }, [driverProfileId]);

  const toggleLanguage = async () => {
    const cycle = ['es', 'en', 'pt'] as const;
    const idx = cycle.indexOf(currentLang as typeof cycle[number]);
    const next = cycle[(idx + 1) % cycle.length]!;
    // Apply locally first so the UI reacts instantly, and persist to
    // AsyncStorage — `app-providers` reads `tricigo_language` on boot, so
    // that is what actually survives a restart.
    i18n.changeLanguage(next);
    AsyncStorage.setItem('tricigo_language', next).catch(() => {});

    // Mirror to the server. The client app has always done this; the
    // driver never did, so `users.preferred_language` stayed at its
    // default for every driver. It is what the admin console displays,
    // and the natural column for any server-sent copy (emails, SMS) to
    // localize from — a driver reading the app in English still got
    // Spanish from the server, with nothing to explain why.
    if (!userId) return;
    try {
      await authService.updateProfile(userId, { preferred_language: next });
    } catch (err) {
      // Non-fatal: the local change already took effect.
      logger.warn('[DriverSettings] Failed to persist language', { error: String(err) });
    }
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
    // Invalidate any load in flight — its data predates this choice.
    prefsGenerationRef.current += 1;
    setCategoryPrefs((prev) => ({ ...prev, [key]: enabled }));

    // On-device first: this is what suppresses a foreground notification.
    await AsyncStorage.setItem(key, String(enabled)).catch(() => {});

    // Then the server, so the push is not sent at all when the app is
    // backgrounded or killed — the case the local filter cannot cover.
    const serverPref = SERVER_PREF_BY_LOCAL_KEY[key];
    if (!userId || !serverPref) return;
    try {
      await notificationService.updatePreferences(userId, { [serverPref]: enabled });
    } catch (err) {
      // Keep the two sides in agreement rather than leaving the device
      // suppressing something the server still sends.
      setCategoryPrefs((prev) => ({ ...prev, [key]: !enabled }));
      await AsyncStorage.setItem(key, String(!enabled)).catch(() => {});
      logger.warn('[DriverSettings] Failed to save notification preference', { error: String(err) });
    }
  }, [userId]);

  /**
   * Persist a matching preference and keep the store in sync, so the
   * value survives navigating away without an extra fetch. Reverts the
   * local state if the write fails — a preference that looks saved but
   * isn't would misrepresent which rides the driver can receive.
   */
  const saveMatchPreferences = async (
    updates: { max_distance_km?: number | null; accepts_long_trips?: boolean | null },
    revert: () => void,
  ) => {
    if (!driverProfileId) {
      // The caller already changed what is on screen. Without this the row
      // would show the new value and never save it — a control that lies,
      // which is the exact thing this screen was cleaned up to stop doing.
      revert();
      return;
    }
    setPrefsSaving(true);
    try {
      const next = await driverService.updateMatchPreferences(driverProfileId, updates);
      const profile = useDriverStore.getState().profile;
      if (profile) useDriverStore.getState().setProfile({ ...profile, preferences: next });
    } catch (err) {
      revert();
      logger.warn('[DriverSettings] Failed to save matching preferences', { error: String(err) });
      Alert.alert(
        t('common.error', { defaultValue: 'Error' }),
        t('profile.prefs_save_failed', { defaultValue: 'No se pudo guardar. Intentá de nuevo.' }),
      );
    } finally {
      setPrefsSaving(false);
    }
  };

  const handleMaxDistanceChange = () => {
    const idx = MAX_DISTANCE_OPTIONS.findIndex((v) => v === maxDistanceKm);
    const next = MAX_DISTANCE_OPTIONS[(idx + 1) % MAX_DISTANCE_OPTIONS.length] ?? null;
    const previous = maxDistanceKm;
    setMaxDistanceKm(next);
    saveMatchPreferences({ max_distance_km: next }, () => setMaxDistanceKm(previous));
  };

  const handleLongTripsToggle = (enabled: boolean) => {
    setAcceptsLongTrips(enabled);
    // `true` clears the key rather than storing it: absent means "no
    // restriction", which is the engine's default and keeps the column
    // free of rows that only restate the default.
    saveMatchPreferences(
      { accepts_long_trips: enabled ? null : false },
      () => setAcceptsLongTrips(!enabled),
    );
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

        </SettingsGroup>

        {/* ── Group 2: Audio ──────────────────────────────────────────── */}
        <SettingsGroup title={t('profile.section_audio', { defaultValue: 'Audio' })}>
          {/* Voice guidance. The preference already existed and is honored
              by the trip navigation strip, but the only way to reach it was
              a button that appears mid-trip — so a driver who wanted the
              voice off had to be driving to turn it off. */}
          <Card theme="light" variant="surface" padding="md" className="mb-3">
            <SettingsRow
              icon="volume-high-outline"
              title={t('profile.voice_guidance', { defaultValue: 'Guía por voz' })}
              subtitle={t('profile.voice_guidance_desc', {
                defaultValue: 'Indicaciones habladas durante la navegación',
              })}
              right={
                <Switch
                  value={voiceGuidanceEnabled}
                  onValueChange={setVoiceGuidanceEnabled}
                  trackColor={SWITCH_TRACK}
                  accessibilityLabel={t('profile.voice_guidance', { defaultValue: 'Guía por voz' })}
                  accessibilityState={{ checked: voiceGuidanceEnabled }}
                />
              }
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
          {/* Matching preferences. Unlike the zone selector and the
              "No recibir viajes" switch that used to sit here, these two
              are read by find_best_drivers, so they genuinely change
              which rides reach this driver. To pause offers without
              going offline, use Modo Descanso on the Inicio tab — that
              is the control that actually does it. */}
          <Card theme="light" variant="surface" padding="md" className="mb-3">
            <MenuRow
              icon="resize-outline"
              label={t('profile.max_distance', { defaultValue: 'Distancia máxima' })}
              subtitle={t('profile.max_distance_desc', {
                defaultValue: 'Solo recibís viajes con recogida dentro de esta distancia',
              })}
              value={
                maxDistanceKm === null
                  ? t('profile.max_distance_none', { defaultValue: 'Sin límite' })
                  : t('profile.max_distance_km', { km: maxDistanceKm, defaultValue: `${maxDistanceKm} km` })
              }
              iconBg="warning"
              onPress={prefsSaving ? undefined : handleMaxDistanceChange}
              showBorder={false}
            />
          </Card>

          <Card theme="light" variant="surface" padding="md" className="mb-3">
            <SettingsRow
              icon="trail-sign-outline"
              title={t('profile.accepts_long_trips', { defaultValue: 'Aceptar viajes largos' })}
              subtitle={t('profile.accepts_long_trips_desc', {
                defaultValue: 'Si lo apagás, no vas a recibir viajes de larga distancia',
              })}
              right={
                <Switch
                  value={acceptsLongTrips}
                  disabled={prefsSaving}
                  onValueChange={handleLongTripsToggle}
                  trackColor={SWITCH_TRACK}
                  accessibilityLabel={t('profile.accepts_long_trips', { defaultValue: 'Aceptar viajes largos' })}
                  accessibilityState={{ checked: acceptsLongTrips, disabled: prefsSaving }}
                />
              }
            />
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
