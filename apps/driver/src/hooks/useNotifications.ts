import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { notificationService } from '@tricigo/api';
import {
  classifyPushPermission,
  shouldSpendPushPrompt,
  describePushError,
  isRetryablePushTokenError,
  shouldFallbackToProxy,
  pushTokenRetryDelayMs,
  PUSH_TOKEN_MAX_ATTEMPTS,
} from '@tricigo/utils';
import type { PushRegistrationOutcome } from '@tricigo/utils';
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
// MUST stay a superset of `FILTERABLE_CATEGORY_TO_PREF` in
// `supabase/functions/send-push/index.ts`. That map decides what the server
// refuses to send; this one is the last line of defence for anything already
// on the device — which is precisely what matters while the two sides briefly
// disagree (offline toggle, a push in flight when the preference changed).
// A category the server can filter but this map omits is silently presented.
const PREF_KEYS: Record<string, string> = {
  // Ride lifecycle
  ride: '@tricigo/notif_rides',
  ride_matching: '@tricigo/notif_rides',
  proximity: '@tricigo/notif_rides',
  scheduled_ride: '@tricigo/notif_rides',
  ride_updates: '@tricigo/notif_rides', // legacy category, still emitted
  // Chat
  chat: '@tricigo/notif_chat',
  // Wallet / payments (driver earnings)
  wallet: '@tricigo/notif_wallet',
  payment: '@tricigo/notif_wallet',
  wallet_recharge: '@tricigo/notif_wallet',
  wallet_recharge_refund: '@tricigo/notif_wallet',
  wallet_credit: '@tricigo/notif_wallet',
  wallet_debit: '@tricigo/notif_wallet',
  // Marketing / content (admin novedades, blog, promos)
  promo: '@tricigo/notif_promos',
  announcement: '@tricigo/notif_promos',
  blog: '@tricigo/notif_promos',
  news: '@tricigo/notif_promos',
  campaign: '@tricigo/notif_promos',
};

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // ride_offer_launch is the data-only companion message that wakes the
    // background auto-launch task (src/tasks/rideOfferLaunchTask.ts). It
    // carries no title/body; in foreground it still reaches this handler,
    // and presenting it would drop an EMPTY notification in the tray. Never
    // show it — the visible offer push is a separate message.
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
    case 'payment':
      // Ride-earning context → Earnings tab.
      router.push('/(tabs)/earnings');
      break;
    case 'wallet':
    case 'wallet_recharge':
    case 'wallet_recharge_refund':
    case 'wallet_credit':
    case 'wallet_debit':
      // Balance events (gifts/recharges, e.g. 00393) open the Wallet tab
      // where the new balance + transaction actually show. Without these
      // cases a tapped wallet push was a dead no-op.
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

/**
 * Android: ensure the high-importance 'rides' channel exists so
 * killed-app pushes (the server sends channelId:'rides') make sound +
 * heads-up. Creating a channel needs no permission and is idempotent,
 * so it runs before the pref/permission gates — a device whose channel
 * is missing stays silent even after the user re-enables everything.
 * Mirrors the client (apps/client/src/services/push.service.ts).
 */
async function ensureAndroidRidesChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('rides', {
    name: 'Viajes y ofertas',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
  });
}

/**
 * Our own stand-in for Expo's token endpoint, for phones whose ISP gets a 403
 * from Google Cloud's edge in front of exp.host.
 *
 * MUST end in a slash: getExpoPushTokenAsync builds the final URL by bare
 * string concatenation — `${baseUrl}push/getExpoPushToken` — with no
 * normalization (getExpoPushTokenAsync.js:62-63).
 *
 * Static dot notation is load-bearing: Metro only substitutes literal
 * `process.env.X` references, so computed access would ship as undefined.
 */
const EXPO_TOKEN_PROXY_URL = process.env.EXPO_PUBLIC_EXPO_TOKEN_PROXY_URL;

/**
 * Mint the Expo token through our proxy instead of straight from the device.
 *
 * Passing `baseUrl` has one documented side effect: expo-notifications skips
 * `setAutoServerRegistrationEnabledAsync(true)`, which is the loop that tells
 * Expo when FCM/APNs rotates the device token. That is an acceptable trade
 * ONLY because this runs after the direct path already failed — the people who
 * land here have no token at all today, so there is nothing to keep fresh.
 * Anyone for whom the direct path works never reaches this and keeps the
 * refresh loop intact.
 */
async function mintTokenViaProxy() {
  if (!EXPO_TOKEN_PROXY_URL) return undefined;
  return Notifications.getExpoPushTokenAsync({
    projectId: Constants.expoConfig?.extra?.eas?.projectId,
    baseUrl: EXPO_TOKEN_PROXY_URL,
  });
}


/**
 * The Expo push token for this device: straight from Expo, or through our proxy
 * if Expo will not answer this phone.
 *
 * Exported because two other places need the token VALUE, not a registration:
 * the settings switch's OFF branch (which deletes the row by token) and, in the
 * client, the startup path in services/push.service.ts. Before this existed,
 * each built its own options object inline and none of them had a fallback — so
 * on a blocked device the OFF branch silently failed to delete the row and the
 * person kept receiving pushes after turning notifications off.
 *
 * Returns undefined rather than throwing: every caller here is best-effort.
 */
export async function resolveExpoPushToken(): Promise<string | undefined> {
  try {
    const direct = await Notifications.getExpoPushTokenAsync({
      projectId: Constants.expoConfig?.extra?.eas?.projectId,
    });
    return direct.data;
  } catch (err) {
    if (!shouldFallbackToProxy(err)) return undefined;
    try {
      return (await mintTokenViaProxy())?.data;
    } catch {
      return undefined;
    }
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
 * this the server had no token until the next cold start — meaning no
 * ride offers at all — while the switch sat there looking enabled.
 *
 * Distinguishes 'denied' from 'error' so the caller can tell an
 * actionable OS-permission problem from a transient failure.
 *
 * `promptIfNeeded` gates the OS permission dialog and defaults to FALSE.
 * Android 13+ shows the POST_NOTIFICATIONS dialog exactly once per
 * install: a denial there is permanent, recoverable only through system
 * Settings. This used to run unguarded from the root provider, so the
 * dialog fired seconds after login — before the driver had seen a single
 * ride offer — and two thirds of them denied it for good. Now only a
 * caller that has already explained the value (the soft-ask sheet, the
 * settings toggle) may pass true; everyone else silently registers the
 * token when permission happens to be granted already.
 */
export async function registerPushTokenForUser(
  userId: string,
  opts?: { promptIfNeeded?: boolean },
): Promise<PushRegistrationResult> {
  // Telemetry ONLY. Deliberately fire-and-forget and deliberately unable to
  // throw (see notificationService.recordPushRegistration): this function's
  // return value and timing must stay exactly what they were, or measuring the
  // problem would change it.
  const report = (outcome: PushRegistrationOutcome, detail?: string) => {
    try {
      void notificationService.recordPushRegistration({
        userId,
        app: 'driver',
        outcome,
        platform: Platform.OS,
        detail,
      });
    } catch {
      // Unreachable in a shipped bundle, and load-bearing anyway: this runs
      // inside the caller's try, so a throw here would turn a SUCCESSFUL
      // registration into 'error' — the measurement corrupting its own number.
    }
  };

  try {
    await ensureAndroidRidesChannel();

    const permissions = await Notifications.getPermissionsAsync();
    let state = classifyPushPermission(permissions);

    if (state !== 'granted') {
      // Never burn the one-shot OS prompt from an unattended code path.
      if (!opts?.promptIfNeeded) {
        report(state);
        return 'denied';
      }
      state = classifyPushPermission(await Notifications.requestPermissionsAsync());
    }

    if (state !== 'granted') {
      report(state);
      return 'denied';
    }

    // Retry ONLY the Expo round-trip, then fall back to our proxy.
    //
    // Its failure in production is a 403 from Google Cloud's edge in front of
    // exp.host, seen from a Cuban IP. The retry was built believing that block
    // was intermittent; the telemetry says otherwise (9 of 10 affected drivers
    // never held a token), so the retry is kept for genuinely flaky cases and
    // the proxy is what actually rescues the rest.
    //
    // The permission gates above stay OUTSIDE the loop on purpose: re-running
    // requestPermissionsAsync is a silent no-op after an answer and would touch
    // the one-shot-prompt semantics.
    let tokenData: Awaited<ReturnType<typeof Notifications.getExpoPushTokenAsync>> | undefined;
    let via = 'via=direct';
    for (let attempt = 0; attempt < PUSH_TOKEN_MAX_ATTEMPTS; attempt += 1) {
      try {
        tokenData = await Notifications.getExpoPushTokenAsync({
          projectId: Constants.expoConfig?.extra?.eas?.projectId,
        });
        break;
      } catch (err) {
        const lastAttempt = attempt === PUSH_TOKEN_MAX_ATTEMPTS - 1;
        if (lastAttempt || !isRetryablePushTokenError(err)) {
          // Direct is exhausted. The 403 that motivated all this is persistent
          // per device/network — measured 2026-09-12, 9 of the 10 drivers who
          // hit it had NEVER held a token — so retrying harder cannot help.
          // Ask a machine Expo will actually answer.
          if (shouldFallbackToProxy(err)) {
            tokenData = await mintTokenViaProxy();
            if (tokenData) {
              via = 'via=proxy';
              break;
            }
          }
          // Rethrow to the outer catch, which reports 'error' — NOT 'denied'.
          // The settings screens read 'denied' as "the OS refused" and turn the
          // switch off with a go-to-Settings alert, which cannot help someone
          // whose network is the problem.
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, pushTokenRetryDelayMs(attempt)));
      }
    }
    if (!tokenData) throw new Error('Expo push token unavailable after retries');

    await notificationService.registerPushToken(
      userId,
      tokenData.data,
      Platform.OS,
    );
    // 'via=' rides in detail rather than becoming a new `outcome` value: the
    // column has a CHECK and the driver_push_reachability view reads it.
    report('registered', via);
    return 'registered';
  } catch (err) {
    report('error', describePushError(err));
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
        // Before the pref gate on purpose — see ensureAndroidRidesChannel.
        await ensureAndroidRidesChannel();

        const pref = await AsyncStorage.getItem(NOTIF_PREF_KEY);
        if (pref === 'false') return;

        // Ask again (2026-09-10). Measured: the share of people holding a
        // token within 7 days of signing up fell from 24 % (July, n=302) to
        // 7 % (August, n=209) when the app stopped asking and left it all to
        // the soft-ask sheet. So we ask — but signed in, not at cold mount
        // like July did, so the person has already seen what TriciGo is.
        // shouldSpendPushPrompt spends the one-shot prompt only while the
        // permission is undetermined; a denial goes to the sheet's Settings
        // deep-link instead, since re-requesting it there shows nothing.
        const promptIfNeeded = shouldSpendPushPrompt(await Notifications.getPermissionsAsync());
        if (cancelled) return;

        const result = await registerPushTokenForUser(userId!, { promptIfNeeded });
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
