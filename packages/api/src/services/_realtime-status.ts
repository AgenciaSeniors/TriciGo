import { logger } from '@tricigo/utils';

/**
 * Status callback for a Supabase Realtime `.subscribe()` that surfaces
 * SILENT channel failures (CHANNEL_ERROR / TIMED_OUT) to the logger so a
 * dead channel is visible in Metro/logcat + as a Sentry breadcrumb instead
 * of disappearing without a trace.
 *
 * Why warn (not error): a CHANNEL_ERROR is often transient — supabase-js
 * reconnects the underlying socket with backoff — so logging at error level
 * would spam Sentry on every network blip. `warn` keeps it observable
 * without the noise. SUBSCRIBED (normal) and CLOSED (normal on teardown)
 * are intentionally ignored.
 *
 * Why NOT reconnect here: BUG-277 showed that extra realtime/WebSocket
 * activity saturates OkHttp's `maxRequestsPerHost = 5` (RN Android) and
 * blocks critical POSTs. This helper is PURE LOGGING — it only attaches a
 * callback to the channel's existing state machine and opens no new
 * connections. Recovery is left to supabase-js's built-in socket reconnect
 * and the app's existing polling fallbacks.
 *
 * Usage: `channel.subscribe(realtimeStatusLogger('ride_offers'))`
 */
export function realtimeStatusLogger(
  label: string,
): (status: string, err?: Error) => void {
  return (status, err) => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      logger.warn(`[realtime] channel "${label}" ${status}`, {
        error: err ? String(err) : undefined,
      });
    }
  };
}
