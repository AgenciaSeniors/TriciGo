import React, { useEffect, useState, useCallback } from 'react';
import { View, Modal, Pressable } from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';

const PROMPT_SHOWN_KEY = '@tricigo/notification_prompt_shown';

/**
 * Shows a friendly bottom sheet explaining why notifications are needed.
 * Only shows once (first app launch after login). Respects OS permission state.
 */
export function NotificationPermissionSheet() {
  const { t } = useTranslation('common');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        // Already shown before?
        const shown = await AsyncStorage.getItem(PROMPT_SHOWN_KEY);
        if (shown) return;

        // Already granted?
        const { status } = await Notifications.getPermissionsAsync();
        if (status === 'granted') {
          await AsyncStorage.setItem(PROMPT_SHOWN_KEY, 'true');
          return;
        }

        // Show the prompt after a short delay (let the home screen load first)
        if (!cancelled) {
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

  const handleEnable = useCallback(async () => {
    try {
      await Notifications.requestPermissionsAsync();
    } catch {
      // User may deny — that's fine
    }
    await AsyncStorage.setItem(PROMPT_SHOWN_KEY, 'true');
    setVisible(false);
  }, []);

  const handleDismiss = useCallback(async () => {
    await AsyncStorage.setItem(PROMPT_SHOWN_KEY, 'true');
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
      <Pressable
        className="flex-1 bg-black/40"
        onPress={handleDismiss}
      />

      {/* Bottom sheet */}
      <View className="bg-white rounded-t-3xl px-6 pt-6 pb-10">
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
          {t('notifications.permission_body', {
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
          title={t('notifications.enable_button', { defaultValue: 'Activar notificaciones' })}
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
