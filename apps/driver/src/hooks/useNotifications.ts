import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { notificationService } from '@tricigo/api';
import { Platform } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export function useNotificationSetup(userId: string | null | undefined) {
  useEffect(() => {
    if (!userId) return;

    let cancelled = false;

    async function register() {
      try {
        const { status: existing } = await Notifications.getPermissionsAsync();
        let finalStatus = existing;

        if (existing !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }

        if (finalStatus !== 'granted') return;

        const tokenData = await Notifications.getExpoPushTokenAsync();
        if (cancelled) return;

        await notificationService.registerPushToken(
          userId!,
          tokenData.data,
          Platform.OS,
        );
      } catch {
        // Silent — notifications are best-effort
      }
    }

    register();

    return () => {
      cancelled = true;
    };
  }, [userId]);
}
