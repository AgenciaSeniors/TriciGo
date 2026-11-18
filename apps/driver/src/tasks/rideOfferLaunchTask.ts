// ============================================================
// TriciGo Driver — Push-driven offer auto-launch (Android)
// ============================================================
// Companion to PR #807 (driver-overlay module). #807 brings the app
// to the foreground when a ride offer arrives over the Realtime
// WebSocket — but that channel disconnects silently in background
// (its own code comment says so; the 30s poll fallback deliberately
// does NOT launch the app), and even when connected it loses the
// race against FCM by several seconds (background sockets are
// deprioritized, plus the callback re-fetches the ride before
// launching). Verified live 2026-07-16: the push notification
// consistently arrived first; the WebSocket launch came late or,
// when the channel had silently dropped, not at all.
//
// This task makes the launch ride on the reliable channel instead:
// send-push emits a SECOND, data-only, high-priority FCM message
// (type: 'ride_offer_launch') for ride offers, addressed only to
// Android devices. Data-only messages show no system notification;
// on Android they wake this background task even when the app is
// backgrounded — and, thanks to the expo-location foreground
// service that keeps the process alive while the driver is online,
// the task body runs immediately.
//
// The visible offer notification is untouched (old builds keep
// working: they simply ignore the extra data-only message). The
// Realtime launch path in useDriverRide stays as redundancy — a
// second bringAppToForeground is a cheap no-op (SINGLE_TOP).
//
// Constraints (same as locationBackgroundTask):
//   - TaskManager.defineTask MUST run at module scope, imported for
//     side effects from app/_layout.tsx before the OS can fire it.
//   - The task body runs without React state; only module-scoped
//     imports are available.
import { Platform } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { logger } from '@tricigo/utils';
import { attemptOfferLaunch } from '@/lib/offerLaunch';

export const RIDE_OFFER_LAUNCH_TASK = 'ride-offer-launch-task';

/**
 * Pull a string field out of the background-task payload.
 * The shape of a data-only FCM message differs across expo-notifications
 * versions and delivery paths (keys at the root, nested under `data`,
 * or JSON-encoded in a `body` string), so probe every known layout
 * instead of trusting one.
 */
function extractField(raw: unknown, field: string): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const payload = raw as Record<string, unknown>;
  const candidates: unknown[] = [payload, payload.data, payload.notification];
  for (const cand of candidates) {
    if (!cand || typeof cand !== 'object') continue;
    const obj = cand as Record<string, unknown>;
    if (typeof obj[field] === 'string') return obj[field] as string;
    // Expo → FCM puts the request's `data` JSON in the `body` key of the
    // data map; RemoteMessageSerializer additionally mirrors it as
    // `dataString` (the documented cross-platform key). Probe both.
    for (const key of ['body', 'dataString'] as const) {
      if (typeof obj[key] === 'string') {
        try {
          const parsed = JSON.parse(obj[key] as string) as Record<string, unknown>;
          if (typeof parsed?.[field] === 'string') return parsed[field] as string;
        } catch { /* not JSON — keep probing */ }
      }
    }
    if (obj.data && typeof obj.data === 'object') {
      const inner = obj.data as Record<string, unknown>;
      if (typeof inner[field] === 'string') return inner[field] as string;
    }
  }
  return undefined;
}

/** The notification `type` of a background-task payload. */
export function extractNotificationType(raw: unknown): string | undefined {
  return extractField(raw, 'type');
}

/** The offer's ride id (notify_driver_new_offer puts `ride_id` in the push data). */
export function extractRideId(raw: unknown): string | undefined {
  return extractField(raw, 'ride_id');
}

TaskManager.defineTask(RIDE_OFFER_LAUNCH_TASK, async ({ data, error }) => {
  try {
    if (error || Platform.OS !== 'android') return;
    if (extractNotificationType(data) !== 'ride_offer_launch') return;

    // attemptOfferLaunch skips when the app is already in front
    // (FirebaseMessagingDelegate.onMessageReceived runs task consumers in
    // foreground too) and when the Realtime path already tried this offer.
    // Without the SYSTEM_ALERT_WINDOW grant it does not launch (Android would
    // ignore it) and the visible push notification remains the UX.
    await attemptOfferLaunch(extractRideId(data) ?? null, 'push');
  } catch (err) {
    // A throwing background task is pure noise — log and swallow.
    logger.warn('[rideOfferLaunch] task failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Register at module load (Android only). registerTaskAsync is
// idempotent; failures are non-fatal — the Realtime launch path and
// the visible push notification still cover the driver.
if (Platform.OS === 'android') {
  Notifications.registerTaskAsync(RIDE_OFFER_LAUNCH_TASK).catch((err) => {
    logger.warn('[rideOfferLaunch] registerTaskAsync failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
