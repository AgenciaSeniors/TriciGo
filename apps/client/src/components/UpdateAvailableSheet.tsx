import React, { useEffect, useState, useCallback } from 'react';
import { View, Modal, Pressable, Linking, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { walletService } from '@tricigo/api/services/wallet';
import { isVersionOutdated } from '@tricigo/utils';

// Latest published store version, maintained by the admin from
// Settings → Platform Config after each store release (mig 00499).
const CONFIG_KEY = 'client_latest_version';
const ANDROID_PACKAGE = 'app.tricigo.client';
const IOS_APP_ID = '6785157005';

// Delay the modal so the home screen loads first, and so it doesn't race
// NotificationPermissionSheet (which surfaces at 1500ms when relevant).
const SHOW_DELAY_MS = 2500;

/**
 * "Update available" bottom sheet. On app open, compares the installed
 * version against the latest store version in platform_config; when
 * outdated, offers a one-tap jump to Play Store / App Store. Dismissible —
 * reappears on the next cold start until the user updates. Silent when the
 * config key is missing (migration not applied) or the network fails.
 */
export function UpdateAvailableSheet() {
  const { t } = useTranslation('common');
  // Rendered inside a transparent RN Modal, which does NOT inherit the app's
  // SafeAreaView — pad the CTAs clear of the home indicator / gesture bar.
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web') return; // no store to link to on web
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      try {
        const current = Constants.expoConfig?.version;
        if (!current) return;
        const latest = await walletService.getConfigValue(CONFIG_KEY);
        if (!latest || !isVersionOutdated(current, latest)) return;
        if (!cancelled) {
          timer = setTimeout(() => {
            if (!cancelled) setVisible(true);
          }, SHOW_DELAY_MS);
        }
      } catch {
        // Silent — key missing (migration not applied) or offline
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const handleUpdate = useCallback(async () => {
    const targets =
      Platform.OS === 'android'
        ? [
            `market://details?id=${ANDROID_PACKAGE}`,
            `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`,
          ]
        : [
            `itms-apps://apps.apple.com/app/id${IOS_APP_ID}`,
            `https://apps.apple.com/app/id${IOS_APP_ID}`,
          ];
    for (const url of targets) {
      try {
        await Linking.openURL(url);
        break;
      } catch {
        // Store app unavailable — fall through to the web URL
      }
    }
    setVisible(false);
  }, []);

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

        {/* Update icon */}
        <View
          className="w-16 h-16 rounded-full items-center justify-center self-center mb-4"
          style={{ backgroundColor: 'rgba(255, 77, 0, 0.08)' }}
        >
          <Ionicons name="arrow-up-circle-outline" size={32} color={colors.brand.orange} />
        </View>

        <Text variant="h4" className="text-center mb-2">
          {t('update.available_title', { defaultValue: 'Actualización disponible' })}
        </Text>

        <Text variant="body" color="secondary" className="text-center mb-6 leading-6">
          {t('update.available_body', {
            defaultValue:
              'Hay una nueva versión de TriciGo disponible. Actualiza para recibir las últimas mejoras y correcciones.',
          })}
        </Text>

        <Button
          title={t('update.update_button', { defaultValue: 'Actualizar' })}
          onPress={handleUpdate}
          fullWidth
          size="lg"
        />

        <Button
          title={t('update.later_button', { defaultValue: 'Más tarde' })}
          variant="ghost"
          onPress={handleDismiss}
          fullWidth
          className="mt-2"
        />
      </View>
    </Modal>
  );
}
