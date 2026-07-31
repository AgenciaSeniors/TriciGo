import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Modal, Pressable, Linking, AppState } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';

// Sibling of NotificationPermissionSheet, with one decisive difference: that
// one is a soft-ask the driver can live without, this one is a hard blocker.
// Without location permission `handleToggleOnline` refuses to go online, so
// the driver simply cannot work.
//
// WHY IT EXISTS. Measured on prod 2026-07-31: eight approved drivers had never
// reported a location and had never once been online — one of them (a triciclo
// driver, the scarcest vehicle) sat approved for nine hours without a single
// shift. All they ever got was a red toast reading "Activa la ubicación para
// conectarte", with no way to act on it: on Android a denied permission is
// never re-prompted by the OS, so tapping the toggle again does nothing
// forever. "Error message only" with no recovery path is precisely the
// anti-pattern this sheet removes.
//
// Two paths, chosen from `canAskAgain` rather than guessed:
//   * can still ask  → spend the OS prompt (usually a driver who has not been
//     asked yet, or dismissed without deciding).
//   * cannot ask     → the OS dialog is spent; Settings is the ONLY way back,
//     so deep-link straight there instead of pretending a retry will work.
//
// The AppState listener is what makes it feel finished: the driver returns
// from Settings and the shift starts by itself, instead of landing on the same
// screen wondering whether it worked.

export function LocationPermissionSheet({
  visible,
  onClose,
  onGranted,
}: {
  visible: boolean;
  onClose: () => void;
  /** Fired when permission shows up as granted — the caller resumes the toggle. */
  onGranted: () => void;
}) {
  const { t } = useTranslation('driver');
  // Rendered inside a transparent RN Modal, which does NOT inherit the app's
  // SafeAreaView — pad the CTAs clear of the home indicator / gesture bar.
  const insets = useSafeAreaInsets();
  const [canAskAgain, setCanAskAgain] = useState(true);
  // onGranted may re-render the parent; keep the effect from re-subscribing.
  const onGrantedRef = useRef(onGranted);
  onGrantedRef.current = onGranted;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    Location.getForegroundPermissionsAsync()
      .then((res) => {
        if (!cancelled) setCanAskAgain(res.canAskAgain);
      })
      .catch(() => {
        // Treat an unreadable permission state as "send them to Settings":
        // that path always works, whereas a prompt that cannot fire strands them.
        if (!cancelled) setCanAskAgain(false);
      });
    return () => { cancelled = true; };
  }, [visible]);

  // Close the loop when they come back from Settings with the permission on.
  useEffect(() => {
    if (!visible) return;
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status === 'granted') {
          onCloseRef.current();
          onGrantedRef.current();
        }
      } catch {
        // Best-effort: they can still tap the button again.
      }
    });
    return () => sub.remove();
  }, [visible]);

  const handlePrimary = useCallback(async () => {
    try {
      if (canAskAgain) {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          onClose();
          onGranted();
          return;
        }
        // Denied just now: the OS prompt is spent, so the only remaining path
        // is Settings. Swap the button over rather than closing on a dead end.
        setCanAskAgain(false);
        return;
      }
      await Linking.openSettings();
    } catch {
      // Settings may refuse to open on some OEM skins — the sheet stays up.
    }
  }, [canAskAgain, onClose, onGranted]);

  if (!visible) return null;

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/40" onPress={onClose} accessibilityLabel={t('location_permission.dismiss_a11y', { defaultValue: 'Cerrar' })} />

      <View
        className="bg-white dark:bg-neutral-900 rounded-t-3xl px-6 pt-6"
        style={{ paddingBottom: Math.max(insets.bottom, 16) + 24 }}
      >
        <View className="w-10 h-1 bg-neutral-200 rounded-full self-center mb-6" />

        <View
          className="w-16 h-16 rounded-full items-center justify-center self-center mb-4"
          style={{ backgroundColor: 'rgba(255, 77, 0, 0.08)' }}
        >
          <Ionicons name="location-outline" size={32} color={colors.brand.orange} />
        </View>

        <Text variant="h4" className="text-center mb-2">
          {t('location_permission.title', { defaultValue: 'Necesitamos tu ubicación' })}
        </Text>

        <Text variant="body" color="secondary" className="text-center mb-6 leading-6">
          {canAskAgain
            ? t('location_permission.body', {
                defaultValue:
                  'Sin ubicación no podemos saber qué viajes te quedan cerca, así que no vas a poder conectarte ni recibir ofertas.',
              })
            : t('location_permission.body_denied', {
                defaultValue:
                  'La ubicación está desactivada para TriciGo, y tu teléfono ya no vuelve a preguntarte. Activala en Ajustes para poder conectarte y recibir viajes.',
              })}
        </Text>

        <View className="mb-6 gap-3">
          {[
            {
              icon: 'car-outline' as const,
              text: t('location_permission.benefit_offers', {
                defaultValue: 'Recibir las ofertas de viaje más cercanas',
              }),
            },
            {
              icon: 'eye-outline' as const,
              text: t('location_permission.benefit_rider', {
                defaultValue: 'Que el pasajero te vea llegar',
              }),
            },
            {
              icon: 'time-outline' as const,
              text: t('location_permission.benefit_always', {
                defaultValue: 'Elegí "Permitir todo el tiempo" para no caerte al minimizar la app',
              }),
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
          title={canAskAgain
            ? t('location_permission.allow_button', { defaultValue: 'Permitir ubicación' })
            : t('location_permission.open_settings_button', { defaultValue: 'Abrir Ajustes' })}
          onPress={handlePrimary}
          fullWidth
          size="lg"
        />

        <Button
          title={t('location_permission.skip_button', { defaultValue: 'Ahora no' })}
          variant="ghost"
          onPress={onClose}
          fullWidth
          className="mt-2"
        />
      </View>
    </Modal>
  );
}
