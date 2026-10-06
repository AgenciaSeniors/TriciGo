import React, { useEffect, useState, useCallback } from 'react';
import { View } from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { authService } from '@tricigo/api';
import { logger } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';

// Let the home screen settle first; NotificationPermissionSheet surfaces at
// 1500 ms and UpdateAvailableSheet at 2500 ms.
const SHOW_DELAY_MS = 4000;

// Same key and re-show interval as NotificationPermissionSheet, which keeps
// them private. Keep in sync with that file.
const PUSH_PROMPT_LAST_SHOWN_KEY = '@tricigo/notification_prompt_last_shown';
const PUSH_PROMPT_RESHOW_MS = 7 * 24 * 60 * 60 * 1000;
// One question at a time: a person who just answered the push prompt is not
// asked about marketing in the same breath.
const PUSH_PROMPT_QUIET_MS = 10 * 60 * 1000;

// At most one attempt per app session (process lifetime). The home screen's
// idle branch mounts and unmounts as the ride flow changes, so this cannot
// live in component state.
let askedThisSession = false;

/**
 * True when the push-permission sheet owns this session: either it was
 * answered in the last few minutes, or it is due now. It only stamps its
 * timestamp once answered, so an unanswered sheet that is still on screen is
 * detected by repeating its own "should I show?" check.
 */
async function pushPromptOwnsThisSession(): Promise<boolean> {
  try {
    const lastRaw = await AsyncStorage.getItem(PUSH_PROMPT_LAST_SHOWN_KEY);
    const last = lastRaw ? parseInt(lastRaw, 10) : 0;
    const age = last && Number.isFinite(last) ? Date.now() - last : Infinity;
    if (age < PUSH_PROMPT_QUIET_MS) return true;
    const { status } = await Notifications.getPermissionsAsync();
    return status !== 'granted' && age >= PUSH_PROMPT_RESHOW_MS;
  } catch {
    // The push sheet stays silent on these same errors, so nothing to avoid.
    return false;
  }
}

/**
 * One-time question for existing users who were never asked about marketing
 * communications (WhatsApp, SMS, email). Shown only when the profile row
 * says `marketing_opt_in === null`: `undefined` means a cached profile or a
 * database without the column, and must never trigger it. Dismissing it via
 * the backdrop is not an answer — it asks again next session.
 */
export function MarketingConsentSheet() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const neverAsked = useAuthStore((s) => s.user?.marketing_opt_in === null);
  const setUser = useAuthStore((s) => s.setUser);
  const [visible, setVisible] = useState(false);
  // The answer being saved (drives the button spinners); null when idle.
  const [savingAnswer, setSavingAnswer] = useState<boolean | null>(null);

  useEffect(() => {
    if (!userId || !neverAsked || askedThisSession) return;
    let cancelled = false;

    const timer = setTimeout(async () => {
      if (cancelled || askedThisSession) return;
      const ownedByPushPrompt = await pushPromptOwnsThisSession();
      // Re-read at fire time: the profile may have changed during the delay.
      if (cancelled || askedThisSession || useAuthStore.getState().user?.marketing_opt_in !== null) return;
      askedThisSession = true;
      if (!ownedByPushPrompt) setVisible(true);
    }, SHOW_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [userId, neverAsked]);

  const handleAnswer = useCallback(async (optIn: boolean) => {
    // Read the id at tap time, not from the render closure.
    const id = useAuthStore.getState().user?.id;
    if (!id) {
      setVisible(false);
      return;
    }
    setSavingAnswer(optIn);
    try {
      const updated = await authService.setMarketingOptIn(id, optIn, 'prompt');
      if (updated) setUser(updated);
    } catch (err) {
      logger.warn('[MarketingConsentSheet] Failed to save marketing consent', { error: String(err) });
    } finally {
      setSavingAnswer(null);
      setVisible(false);
    }
  }, [setUser]);

  const handleClose = useCallback(() => {
    if (savingAnswer !== null) return;
    setVisible(false);
  }, [savingAnswer]);

  return (
    <BottomSheet visible={visible} onClose={handleClose}>
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
        loading={savingAnswer === true}
        disabled={savingAnswer !== null}
        fullWidth
        size="lg"
      />

      <Button
        title={t('profile.marketing_prompt_no', { defaultValue: 'No, gracias' })}
        variant="ghost"
        onPress={() => handleAnswer(false)}
        loading={savingAnswer === false}
        disabled={savingAnswer !== null}
        fullWidth
        className="mt-2"
      />
    </BottomSheet>
  );
}
