import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { notificationService } from '@tricigo/api';
import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';

const NOTIF_PREF_KEY = '@tricigo/notifications_enabled';

// Preference keys for granular filtering. Multiple notification
// `data.type` values can map to the same toggle when they belong to
// the same UX category. Note: `ride_offer` is intentionally NOT
// mapped here — offers are core to being a working driver, so the
// only way to silence them is the master toggle (which is
// effectively going offline). See PR follow-up doc.
const PREF_KEYS: Record<string, string> = {
  // Ride lifecycle
  ride: '@tricigo/notif_rides',
  proximity: '@tricigo/notif_rides',
  scheduled_ride: '@tricigo/notif_rides',
  // Chat
  chat: '@tricigo/notif_chat',
  // Wallet / payments (driver earnings)
  wallet: '@tricigo/notif_wallet',
  payment: '@tricigo/notif_wallet',
  wallet_recharge: '@tricigo/notif_wallet',
  wallet_recharge_refund: '@tricigo/notif_wallet',
  // Marketing / content (admin novedades, blog, promos)
  promo: '@tricigo/notif_promos',
  announcement: '@tricigo/notif_promos',
  blog: '@tricigo/notif_promos',
  news: '@tricigo/notif_promos',
};

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // Check master toggle first
    const masterPref = await AsyncStorage.getItem(NOTIF_PREF_KEY);
    if (masterPref === 'false') {
      return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false, shouldShowBanner: false, shouldShowList: false };
    }

    // Check granular preference for this notification category
    const category = notification.request.content.data?.type as string | undefined;
    if (category && PREF_KEYS[category]) {
      const pref = await AsyncStorage.getItem(PREF_KEYS[category]);
      if (pref === 'false') {
        return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false, shouldShowBanner: false, shouldShowList: false };
      }
    }

    return {
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    };
  },
});

/** Navigate to the appropriate screen based on notification data */
function handleNotificationNavigation(data: Record<string, unknown> | undefined) {
  if (!data?.type) return;

  switch (data.type) {
    case 'ride':
      // Home tab shows active trip automatically
      router.push('/(tabs)');
      break;
    case 'ride_offer':
      // Home tab subscribes to ride_offers via Realtime and renders
      // the incoming offer modal. If the offer expired between push
      // delivery and tap, the home tab shows the "no longer available"
      // state — both paths are already handled in (tabs)/index.tsx.
      router.push('/(tabs)');
      break;
    case 'chat':
      if (data.ride_id) {
        router.push(`/chat/${data.ride_id}`);
      }
      break;
    case 'wallet':
    case 'payment':
    case 'wallet_recharge':
      router.push('/(tabs)/earnings');
      break;
    case 'announcement':
    case 'blog':
    case 'news':
    case 'promo':
    case 'system':
      // Admin content (novedades/blog/promos) lives on the home tab.
      router.push('/(tabs)');
      break;
    default:
      break;
  }
}

export function useNotificationSetup(userId: string | null | undefined) {
  const responseListenerRef = useRef<Notifications.EventSubscription | null>(null);

  useEffect(() => {
    if (!userId) return;

    let cancelled = false;

    async function register() {
      try {
        // Android: ensure the high-importance 'rides' channel exists so
        // killed-app pushes (the server sends channelId:'rides') make
        // sound + heads-up. Channel creation needs no permission and is
        // idempotent, so do it first — before the pref/permission gates.
        // Mirrors the client (apps/client/src/services/push.service.ts).
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('rides', {
            name: 'Viajes y ofertas',
            importance: Notifications.AndroidImportance.HIGH,
            vibrationPattern: [0, 250, 250, 250],
          });
        }

        const pref = await AsyncStorage.getItem(NOTIF_PREF_KEY);
        if (pref === 'false') return;

        const { status: existing } = await Notifications.getPermissionsAsync();
        let finalStatus = existing;

        if (existing !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }

        if (finalStatus !== 'granted') return;

        const tokenData = await Notifications.getExpoPushTokenAsync({
          projectId: Constants.expoConfig?.extra?.eas?.projectId,
        });
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

    // Handle notification taps (app in background)
    responseListenerRef.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data;
        handleNotificationNavigation(data as Record<string, unknown>);
      },
    );

    // Handle cold-start: notification that launched the app
    // getLastNotificationResponseAsync is not available on web
    (Platform.OS !== 'web' ? Notifications.getLastNotificationResponseAsync() : Promise.resolve(null)).then((response) => {
      if (response && !cancelled) {
        const data = response.notification.request.content.data;
        handleNotificationNavigation(data as Record<string, unknown>);
      }
    });

    // Clear badge when app comes to foreground
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        Notifications.setBadgeCountAsync(0);
      }
    });

    // Clear badge on initial mount too
    Notifications.setBadgeCountAsync(0);

    return () => {
      cancelled = true;
      responseListenerRef.current?.remove();
      appStateSubscription.remove();
    };
  }, [userId]);
}
