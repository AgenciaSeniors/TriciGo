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
// the same UX category (e.g. all ride-related events share the
// rides toggle). Without these aliases, a new type like
// 'wallet_recharge' would bypass the user's "wallet" preference
// because PREF_KEYS['wallet_recharge'] would be undefined and the
// handler defaults to shouldShowAlert: true.
const PREF_KEYS: Record<string, string> = {
  // Ride lifecycle
  ride: '@tricigo/notif_rides',
  ride_matching: '@tricigo/notif_rides',
  proximity: '@tricigo/notif_rides',
  // Chat
  chat: '@tricigo/notif_chat',
  // Wallet / payments
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
    // ride_offer_launch is a data-only companion message for the DRIVER
    // app's background auto-launch task. It can reach the client too when
    // the same account is logged into both apps (user_devices doesn't
    // distinguish apps). It has no title/body — presenting it would drop an
    // EMPTY notification in the tray. Never show it here.
    if (notification.request.content.data?.type === 'ride_offer_launch') {
      return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false, shouldShowBanner: false, shouldShowList: false };
    }

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
    case 'ride_matching':
    case 'proximity':
      // Home tab shows active ride automatically
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
    case 'wallet_recharge_refund':
    case 'wallet_credit':
    case 'wallet_debit':
      // wallet_credit/debit are sent by gifts/tips/payments (e.g. 00393).
      // Without these cases a tapped wallet push was a dead no-op.
      router.push('/(tabs)/wallet');
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
      // Any other category (lost_item, dispute_update, scheduled_ride,
      // delivery, campaign, sos, …): open home instead of a dead no-op,
      // matching the in-app inbox fallback (notifications/index.tsx).
      router.push('/(tabs)');
      break;
  }
}

/** Outcome of a push-token registration attempt. */
export type PushRegistrationResult = 'registered' | 'denied' | 'error';

/**
 * Register this device's push token for `userId`.
 *
 * Exported because the settings screen must be able to re-register on
 * demand: turning the master notifications switch OFF deletes the token
 * row server-side, and turning it back ON has to put it back. Without
 * this the server had no token until the next cold start, while the
 * switch sat there looking enabled.
 *
 * Deliberately NOT reusing `registerForPushNotifications()` from
 * `src/services/push.service.ts`, even though it does the same job:
 * importing that module installs a second `setNotificationHandler` that
 * does not consult the master/category preferences, and which handler
 * wins depends on import order (see the note in that file). Pulling it
 * into the settings screen could silently disable notification
 * suppression app-wide.
 *
 * Distinguishes 'denied' from 'error' so the caller can tell an
 * actionable OS-permission problem from a transient failure.
 */
export async function registerPushTokenForUser(
  userId: string,
): Promise<PushRegistrationResult> {
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;

    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') return 'denied';

    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: Constants.expoConfig?.extra?.eas?.projectId,
    });

    await notificationService.registerPushToken(
      userId,
      tokenData.data,
      Platform.OS,
    );
    return 'registered';
  } catch {
    return 'error';
  }
}

export function useNotificationSetup(userId: string | null | undefined) {
  const responseListenerRef = useRef<Notifications.EventSubscription | null>(null);
  const registeredRef = useRef(false);

  useEffect(() => {
    if (!userId) return;

    let cancelled = false;
    registeredRef.current = false;

    async function register() {
      try {
        const pref = await AsyncStorage.getItem(NOTIF_PREF_KEY);
        if (pref === 'false') return;

        const result = await registerPushTokenForUser(userId!);
        if (cancelled) return;
        if (result === 'registered') registeredRef.current = true;
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
        // R-1: retry registration if the user just enabled notifications from
        // system Settings (the only recovery after an initial OS denial).
        // register() re-checks permission and is a silent no-op once we've
        // registered this session, so this won't spam.
        if (!registeredRef.current) register();
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
