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

// Driver copy of the rider soft-ask. Push matters most for the driver: ride
// offers arrive as pushes when the app is backgrounded. Re-surfaces at most
// once per RESHOW_INTERVAL_MS while notifications are NOT granted so a driver
// who denied isn't stranded — the OS never re-prompts after the first denial,
// so when permission is already 'denied' the button deep-links to Settings.
const PROMPT_LAST_SHOWN_KEY = '@tricigo/notification_prompt_last_shown';
const RESHOW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Friendly bottom sheet explaining why notifications are needed for drivers.
 * Re-surfaces periodically while permission is not granted (capped to once
 * per 7 days) and routes denied users to system Settings.
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
        if (status === 'granted') return;

        const lastRaw = await AsyncStorage.getItem(PROMPT_LAST_SHOWN_KEY);
        const last = lastRaw ? parseInt(lastRaw, 10) : 0;
        if (last && Number.isFinite(last) && Date.now() - last < RESHOW_INTERVAL_MS) return;

        if (!cancelled) {
          setDenied(status === 'denied');
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
          {t('notifications.driver_permission_title', { defaultValue: 'Activá las notificaciones' })}
        </Text>

        <Text variant="body" color="secondary" className="text-center mb-6 leading-6">
          {denied
            ? t('notifications.driver_permission_body_denied', {
                defaultValue:
                  'Las notificaciones están desactivadas. Activalas en Ajustes para no perderte las ofertas de viaje, los mensajes del pasajero y tus pagos.',
              })
            : t('notifications.driver_permission_body', {
                defaultValue:
                  'Te avisamos al instante cuando entra una oferta de viaje, cuando el pasajero te escribe y de tus pagos. Sin spam.',
              })}
        </Text>

        {/* Benefits list */}
        <View className="mb-6 gap-3">
          {[
            {
              icon: 'car-outline' as const,
              text: t('notifications.driver_benefit_offers', { defaultValue: 'Recibir ofertas de viaje al instante' }),
            },
            {
              icon: 'chatbubble-outline' as const,
              text: t('notifications.driver_benefit_chat', { defaultValue: 'Mensajes del pasajero' }),
            },
            {
              icon: 'wallet-outline' as const,
              text: t('notifications.driver_benefit_earnings', { defaultValue: 'Confirmaciones de pagos y recargas' }),
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
