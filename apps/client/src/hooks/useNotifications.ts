import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { notificationService } from '@tricigo/api';
import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';

const NOTIF_PREF_KEY = '@tricigo/notifications_enabled';

/**
 * The four on-device toggles the notification handler below consults.
 * These are the ONLY values that gate whether a notification is shown.
 */
export const LOCAL_NOTIF_KEYS = {
  rides: '@tricigo/notif_rides',
  chat: '@tricigo/notif_chat',
  wallet: '@tricigo/notif_wallet',
  promos: '@tricigo/notif_promos',
} as const;

/**
 * Maps a `notification_preferences` column (what the settings screen
 * persists, and what the web writes too) to the on-device key that
 * actually enforces it.
 *
 * This mapping exists because the two halves were built and never
 * connected: the handler read these four keys, the settings screen only
 * ever wrote the server columns under different names, so `getItem`
 * always returned null and no category toggle suppressed anything.
 *
 * Kept here, next to the handler that consumes the keys, so the mapping
 * cannot drift away from its only enforcement point.
 *
 * `driver_approval` is intentionally absent: it is a driver-only
 * category, never delivered to a passenger, so it has no local key.
 */
export const SERVER_PREF_TO_LOCAL_KEY = {
  ride_updates: LOCAL_NOTIF_KEYS.rides,
  chat_messages: LOCAL_NOTIF_KEYS.chat,
  payment_updates: LOCAL_NOTIF_KEYS.wallet,
  promotions: LOCAL_NOTIF_KEYS.promos,
} as const;

export type ServerNotifPref = keyof typeof SERVER_PREF_TO_LOCAL_KEY;

/**
 * Mirror server-side preferences onto the device keys the handler reads.
 * Call after loading preferences, and whenever one is toggled, so a
 * change made here or on another device actually takes effect.
 */
export async function syncNotifPrefsToDevice(
  prefs: Partial<Record<ServerNotifPref, boolean>>,
): Promise<void> {
  await Promise.all(
    (Object.entries(prefs) as [ServerNotifPref, boolean | undefined][]).map(
      ([pref, value]) => {
        const key = SERVER_PREF_TO_LOCAL_KEY[pref];
        if (!key || typeof value !== 'boolean') return Promise.resolve();
        return AsyncStorage.setItem(key, String(value)).catch(() => {});
      },
    ),
  );
}

/**
 * Read the on-device preferences. Used by the settings screen to paint
 * the switches from the values that are actually in force, instead of
 * defaulting everything to "on" until the server responds.
 */
export async function readDeviceNotifPrefs(): Promise<Record<ServerNotifPref, boolean>> {
  const prefs = Object.keys(SERVER_PREF_TO_LOCAL_KEY) as ServerNotifPref[];
  const entries = await Promise.all(
    prefs.map(async (pref) => {
      const stored = await AsyncStorage.getItem(SERVER_PREF_TO_LOCAL_KEY[pref]).catch(() => null);
      // Absent means "never turned off" — the handler treats anything
      // other than the string 'false' as enabled.
      return [pref, stored !== 'false'] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<ServerNotifPref, boolean>;
}

// Preference keys for granular filtering. Multiple notification
// `data.type` values can map to the same toggle when they belong to
// the same UX category (e.g. all ride-related events share the
// rides toggle). Without these aliases, a new type like
// 'wallet_recharge' would bypass the user's "wallet" preference
// because PREF_KEYS['wallet_recharge'] would be undefined and the
// handler defaults to shouldShowAlert: true.
// MUST stay a superset of `FILTERABLE_CATEGORY_TO_PREF` in
// `supabase/functions/send-push/index.ts`. That map decides what the server
// refuses to send; this one is the last line of defence for anything already
// on the device — which is precisely what matters while the two sides briefly
// disagree (offline toggle, a push in flight when the preference changed).
// A category the server can filter but this map omits is silently presented.
const PREF_KEYS: Record<string, string> = {
  // Ride lifecycle
  ride: LOCAL_NOTIF_KEYS.rides,
  ride_matching: LOCAL_NOTIF_KEYS.rides,
  proximity: LOCAL_NOTIF_KEYS.rides,
  scheduled_ride: LOCAL_NOTIF_KEYS.rides,
  ride_updates: LOCAL_NOTIF_KEYS.rides, // legacy category, still emitted
  // Chat
  chat: LOCAL_NOTIF_KEYS.chat,
  // Wallet / payments
  wallet: LOCAL_NOTIF_KEYS.wallet,
  payment: LOCAL_NOTIF_KEYS.wallet,
  wallet_recharge: LOCAL_NOTIF_KEYS.wallet,
  wallet_recharge_refund: LOCAL_NOTIF_KEYS.wallet,
  wallet_credit: LOCAL_NOTIF_KEYS.wallet,
  wallet_debit: LOCAL_NOTIF_KEYS.wallet,
  // Marketing / content (admin novedades, blog, promos)
  promo: LOCAL_NOTIF_KEYS.promos,
  announcement: LOCAL_NOTIF_KEYS.promos,
  blog: LOCAL_NOTIF_KEYS.promos,
  news: LOCAL_NOTIF_KEYS.promos,
  campaign: LOCAL_NOTIF_KEYS.promos,
};

// THE notification handler for this app — there must be exactly one.
// `setNotificationHandler` replaces the global handler instead of adding
// to it, so a second call anywhere silently disables everything below.
// `src/services/push.service.ts` used to make one and, being imported
// later by the root layout, won: preferences were never consulted in the
// foreground. Its handler is gone; keep it that way.
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
 * Overlaps with `registerForPushNotifications()` in
 * `src/services/push.service.ts`, which the root layout calls once at
 * startup. They are kept separate on purpose: that one resolves the user
 * from the session and returns a token, this one takes an explicit
 * userId and reports WHY it failed, which is what the settings toggle
 * needs in order to react.
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
