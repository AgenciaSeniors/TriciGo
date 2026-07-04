import React, { useEffect, useState, useCallback } from 'react';
import { View, Modal, Pressable, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';

// Timestamp (ms) of the last time we surfaced the soft-ask. We re-surface at
// most once per RESHOW_INTERVAL_MS while notifications are NOT granted, so a
// user who dismissed or denied isn't stranded forever (the previous version
// showed this once and never again). The OS never re-prompts after the first
// denial — the only recovery is system Settings — so when the permission is
// already 'denied' the primary button deep-links there instead of firing a
// silent no-op requestPermissions().
const PROMPT_LAST_SHOWN_KEY = '@tricigo/notification_prompt_last_shown';
const RESHOW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Friendly bottom sheet explaining why notifications are needed. Re-surfaces
 * periodically while permission is not granted (capped to once per 7 days so
 * it informs without nagging) and routes denied users to system Settings.
 */
export function NotificationPermissionSheet() {
  const { t } = useTranslation('common');
  // Rendered inside a transparent RN Modal, which does NOT inherit the app's
  // SafeAreaView — pad the CTAs clear of the home indicator / gesture bar.
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const { status } = await Notifications.getPermissionsAsync();
        if (status === 'granted') return; // already on — nothing to nudge

        // Re-show at most once per interval so we inform without nagging.
        const lastRaw = await AsyncStorage.getItem(PROMPT_LAST_SHOWN_KEY);
        const last = lastRaw ? parseInt(lastRaw, 10) : 0;
        if (last && Number.isFinite(last) && Date.now() - last < RESHOW_INTERVAL_MS) return;

        if (!cancelled) {
          setDenied(status === 'denied');
          // Show after a short delay (let the home screen load first)
          setTimeout(() => {
            if (!cancelled) setVisible(true);
          }, 1500);
        }
      } catch {
        // Silent — best effort
      }
    }

    check();
    return () => { cancelled = true; };
  }, []);

  const markShown = useCallback(async () => {
    try {
      await AsyncStorage.setItem(PROMPT_LAST_SHOWN_KEY, String(Date.now()));
    } catch {
      // best-effort
    }
  }, []);

  const handleEnable = useCallback(async () => {
    try {
      // Re-read status fresh: if the OS already denied us, requestPermissions
      // is a silent no-op, so the only way back is system Settings.
      const { status } = await Notifications.getPermissionsAsync();
      if (status === 'denied') {
        await Linking.openSettings();
      } else {
        await Notifications.requestPermissionsAsync();
      }
    } catch {
      // User may deny / Settings may fail to open — that's fine
    }
    await markShown();
    setVisible(false);
  }, [markShown]);

  const handleDismiss = useCallback(async () => {
    await markShown();
    setVisible(false);
  }, [markShown]);

  if (!visible) return null;

  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={handleDismiss}
    >
      {/* Backdrop */}
      <Pressable
        className="flex-1 bg-black/40"
        onPress={handleDismiss}
      />

      {/* Bottom sheet */}
      <View
        className="bg-white dark:bg-neutral-900 rounded-t-3xl px-6 pt-6"
        style={{ paddingBottom: Math.max(insets.bottom, 16) + 24 }}
      >
        {/* Handle */}
        <View className="w-10 h-1 bg-neutral-200 rounded-full self-center mb-6" />

        {/* Bell icon */}
        <View
          className="w-16 h-16 rounded-full items-center justify-center self-center mb-4"
          style={{ backgroundColor: 'rgba(255, 77, 0, 0.08)' }}
        >
          <Ionicons name="notifications-outline" size={32} color={colors.brand.orange} />
        </View>

        <Text variant="h4" className="text-center mb-2">
          {t('notifications.permission_title', { defaultValue: 'Activa las notificaciones' })}
        </Text>

        <Text variant="body" color="secondary" className="text-center mb-6 leading-6">
          {denied
            ? t('notifications.permission_body_denied', {
                defaultValue:
                  'Las notificaciones están desactivadas. Activalas en Ajustes para enterarte cuando un conductor acepte tu viaje, llegue al punto de recogida, y cuando recibas mensajes.',
              })
            : t('notifications.permission_body', {
                defaultValue:
                  'Te avisaremos cuando un conductor acepte tu viaje, llegue al punto de recogida, y cuando recibas mensajes. No enviaremos spam.',
              })}
        </Text>

        {/* Benefits list */}
        <View className="mb-6 gap-3">
          {[
            {
              icon: 'car-outline' as const,
              text: t('notifications.benefit_ride', { defaultValue: 'Saber cuándo tu conductor está en camino' }),
            },
            {
              icon: 'chatbubble-outline' as const,
              text: t('notifications.benefit_chat', { defaultValue: 'Recibir mensajes del conductor' }),
            },
            {
              icon: 'wallet-outline' as const,
              text: t('notifications.benefit_wallet', { defaultValue: 'Confirmaciones de pagos y recargas' }),
            },
          ].map((item) => (
            <View key={item.icon} className="flex-row items-center gap-3">
              <View
                className="w-8 h-8 rounded-full items-center justify-center"
                style={{ backgroundColor: 'rgba(255, 77, 0, 0.06)' }}
              >
                <Ionicons name={item.icon} size={16} color={colors.brand.orange} />
              </View>
              <Text variant="bodySmall" className="flex-1">{item.text}</Text>
            </View>
          ))}
        </View>

        <Button
          title={denied
            ? t('notifications.open_settings_button', { defaultValue: 'Abrir Ajustes' })
            : t('notifications.enable_button', { defaultValue: 'Activar notificaciones' })}
          onPress={handleEnable}
          fullWidth
          size="lg"
        />

        <Button
          title={t('notifications.skip_button', { defaultValue: 'Ahora no' })}
          variant="ghost"
          onPress={handleDismiss}
          fullWidth
          className="mt-2"
        />
      </View>
    </Modal>
  );
}
