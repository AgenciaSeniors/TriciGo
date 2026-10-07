/**
 * Notification responses (taps) this process already handled, by notification identifier.
 *
 * getLastNotificationResponseAsync keeps returning the last tap for the life of the process, and
 * useNotificationSetup asks for it again whenever userId changes (sign out and back in), so an old
 * tap would navigate again and, for a `ride_assigned` push, run its notice again. The tap listener
 * and the cold-start read can also both report the tap that launched the app. Claiming the
 * identifier makes each response run once.
 */
const MAX_REMEMBERED = 50;
const handled: string[] = [];

/** True the first time a response is seen; false for one already handled. */
export function claimNotificationResponse(identifier: string | null | undefined): boolean {
  // Without an identifier there is nothing to match on: handle it rather than drop a real tap.
  if (!identifier) return true;
  if (handled.includes(identifier)) return false;
  handled.unshift(identifier);
  if (handled.length > MAX_REMEMBERED) handled.length = MAX_REMEMBERED;
  return true;
}
