import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Modal, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { authService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useDriverRideStore } from '@/stores/ride.store';

// Let the home screen settle first, and stay clear of the push soft-ask
// (1500ms) and the update sheet (2500ms) that share this layout.
const SHOW_DELAY_MS = 4000;

// MIRRORS NotificationPermissionSheet.tsx (PROMPT_LAST_SHOWN_KEY and
// RESHOW_INTERVAL_MS) — keep in sync. That sheet stamps the key when the
// driver ANSWERS it, not when it appears.
const PUSH_PROMPT_LAST_SHOWN_KEY = '@tricigo/notification_prompt_last_shown';
const PUSH_PROMPT_RESHOW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Answered the push question this recently → don't ask a second question now.
const PUSH_PROMPT_QUIET_MS = 10 * 60 * 1000; // 10 minutes

// At most one attempt per app session (process lifetime), shown or skipped.
let handledThisSession = false;

function isTripInProgress(trip: { status: string } | null): boolean {
  return !!trip && trip.status !== 'completed' && trip.status !== 'canceled';
}

/**
 * Ask only while the driver is at rest. A native Modal sits above every
 * screen: shown to an online driver it would cover an incoming ride offer
 * (the app is often opened BY an offer, via auto-launch), and mid-trip it
 * would cover the trip controls. Offline means no offers can arrive.
 */
function isDriverAtRest(): boolean {
  const { isProfileLoaded, isOnline } = useDriverStore.getState();
  return isProfileLoaded && !isOnline && !isTripInProgress(useDriverRideStore.getState().activeTrip);
}

/**
 * Does the push soft-ask own this session? True when it was answered within
 * the last 10 minutes, or when it is due to surface now — the same test
 * NotificationPermissionSheet runs on mount. Must run at MOUNT: the push
 * sheet only writes its key once answered, so at the 4000ms mark a sheet
 * that is still open (or still registering the token after "Activar") looks
 * identical to one that never showed, and the two modals would stack.
 */
async function pushPromptOwnsSession(): Promise<boolean> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    const lastRaw = await AsyncStorage.getItem(PUSH_PROMPT_LAST_SHOWN_KEY);
    const last = lastRaw ? parseInt(lastRaw, 10) : 0;
    const age = last && Number.isFinite(last) ? Date.now() - last : Infinity;
    if (age < PUSH_PROMPT_QUIET_MS) return true;
    return status !== 'granted' && age >= PUSH_PROMPT_RESHOW_INTERVAL_MS;
  } catch {
    // The push sheet stays silent on the same failure, so nothing competes.
    return false;
  }
}

/**
 * One-time question for drivers who registered before the marketing-consent
 * checkbox existed: may we send news and promotions by WhatsApp, SMS and
 * email? Shown only while `users.marketing_opt_in` is exactly `null` (never
 * asked). `undefined` means a cached user or a database without the column
 * yet — never ask then. Opens 4s after those conditions hold while the
 * driver is at rest (see isDriverAtRest), at most once per app session, and
 * never in a session the push soft-ask owns. Either answer is recorded with
 * source 'prompt'; the backdrop only hides it, so a driver who skips is asked
 * again next session. The choice can be changed any time from Settings.
 */
export function MarketingConsentSheet() {
  const { t } = useTranslation('common');
  // Rendered inside a transparent RN Modal, which does NOT inherit the app's
  // SafeAreaView — pad the CTAs clear of the home indicator / gesture bar.
  const insets = useSafeAreaInsets();
  const userId = useAuthStore((s) => s.user?.id);
  const needsAnswer = useAuthStore((s) => s.user?.marketing_opt_in === null);
  const setUser = useAuthStore((s) => s.setUser);
  const driverIdle = useDriverStore((s) => s.isProfileLoaded && !s.isOnline);
  const noTripInProgress = useDriverRideStore((s) => !isTripInProgress(s.activeTrip));
  const atRest = driverIdle && noTripInProgress;
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState<'yes' | 'no' | null>(null);
  const pushOwnsSessionRef = useRef<Promise<boolean> | null>(null);

  // Snapshot the push sheet's state at mount, before it can change it.
  useEffect(() => {
    pushOwnsSessionRef.current = pushPromptOwnsSession();
  }, []);

  useEffect(() => {
    if (handledThisSession || !userId || !needsAnswer || !atRest) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      (pushOwnsSessionRef.current ?? Promise.resolve(false)).then((pushOwnsSession) => {
        if (cancelled || handledThisSession) return;
        // Re-read at fire time: the answer may have arrived meanwhile, or
        // the driver may have gone online (the effect re-arms when they
        // are back at rest).
        if (useAuthStore.getState().user?.marketing_opt_in !== null) return;
        if (!isDriverAtRest()) return;
        handledThisSession = true;
        if (!pushOwnsSession) setVisible(true);
      });
    }, SHOW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [userId, needsAnswer, atRest]);

  // A trip restored from the server, or the driver going online, after the
  // sheet opened: get out of the way. Not asked again this session.
  useEffect(() => {
    if (visible && !atRest) setVisible(false);
  }, [visible, atRest]);

  const handleAnswer = useCallback(
    async (optIn: boolean) => {
      const user = useAuthStore.getState().user;
      if (!user) {
        setVisible(false);
        return;
      }
      setSaving(optIn ? 'yes' : 'no');
      try {
        const updated = await authService.setMarketingOptIn(user.id, optIn, 'prompt');
        // Skip if the session changed while saving: setUser on a signed-out
        // store would sign the old user back in.
        if (updated && useAuthStore.getState().user?.id === updated.id) setUser(updated);
      } catch (err) {
        console.warn('[MarketingConsentSheet] Failed to save marketing consent', err);
      } finally {
        setSaving(null);
        setVisible(false);
      }
    },
    [setUser],
  );

  const handleDismiss = useCallback(() => {
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={handleDismiss}
    >
      {/* Backdrop */}
      <Pressable className="flex-1 bg-black/40" onPress={handleDismiss} />

      {/* Bottom sheet */}
      <View
        className="bg-white dark:bg-neutral-900 rounded-t-3xl px-6 pt-6"
        style={{ paddingBottom: Math.max(insets.bottom, 16) + 24 }}
      >
        {/* Handle */}
        <View className="w-10 h-1 bg-neutral-200 rounded-full self-center mb-6" />

        {/* Megaphone icon */}
        <View
          className="w-16 h-16 rounded-full items-center justify-center self-center mb-4"
          style={{ backgroundColor: 'rgba(255, 77, 0, 0.08)' }}
        >
          <Ionicons name="megaphone-outline" size={32} color={colors.brand.orange} />
        </View>

        <Text variant="h4" className="text-center mb-2">
          {t('profile.marketing_prompt_title', { defaultValue: '¿Te escribimos con novedades?' })}
        </Text>

        <Text variant="body" color="secondary" className="text-center mb-6 leading-6">
          {t('profile.marketing_prompt_body', {
            defaultValue:
              'Promociones, descuentos y novedades de TriciGo por WhatsApp, SMS y correo. Puedes cambiarlo cuando quieras en Ajustes.',
          })}
        </Text>

        <Button
          title={t('profile.marketing_prompt_yes', { defaultValue: 'Sí, quiero' })}
          onPress={() => handleAnswer(true)}
          loading={saving === 'yes'}
          disabled={saving !== null}
          fullWidth
          size="lg"
        />

        <Button
          title={t('profile.marketing_prompt_no', { defaultValue: 'No, gracias' })}
          variant="ghost"
          onPress={() => handleAnswer(false)}
          loading={saving === 'no'}
          disabled={saving !== null}
          fullWidth
          className="mt-2"
        />
      </View>
    </Modal>
  );
}
