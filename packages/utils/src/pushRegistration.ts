/**
 * Push registration telemetry.
 *
 * `user_devices` can only ever record a SUCCESS. A user who refused the OS
 * notification permission, one who was never asked, and one whose token minting
 * threw all look identical from the server: no row. Measured 2026-09-08, 74 % of
 * the people who used TriciGo in the last month have no row — and nothing
 * anywhere said which of the three it was, because `registerPushTokenForUser`
 * returned its result to callers that discarded it.
 *
 * These types are the vocabulary the apps report to `push_registration_status`
 * so that question becomes answerable. The distinction that matters:
 *
 *   never_asked  we never put the question to them        → our bug
 *   blocked      they refused and the OS won't ask again  → needs Settings
 *   denied       they refused, a prompt could still work  → needs a better ask
 *   error        permission was fine, the plumbing failed → a real bug
 */

/** What the OS says about the notification permission right now. */
export type PushPermissionState = 'granted' | 'never_asked' | 'denied' | 'blocked';

/** What a registration attempt ended up doing. */
export type PushRegistrationOutcome = Exclude<PushPermissionState, 'granted'> | 'registered' | 'error';

/**
 * The shape of `expo-notifications`' permission response that we care about.
 * Deliberately loose: this runs on whatever the installed APK's SDK returns.
 */
export interface PushPermissionSnapshot {
  status?: string | null;
  canAskAgain?: boolean | null;
}

/**
 * Map an OS permission snapshot onto the reason a token is (or is not) obtainable.
 *
 * `canAskAgain` is the load-bearing field, not `status`: it alone says whether a
 * prompt can still recover this user, which is what decides between "ask better"
 * and "deep-link to Settings".
 */
export function classifyPushPermission(snapshot: PushPermissionSnapshot): PushPermissionState {
  if (snapshot.status === 'granted') return 'granted';
  if (snapshot.canAskAgain === false) return 'blocked';
  if (snapshot.status === 'undetermined') return 'never_asked';
  // Unknown or absent status: we know it is not granted, but we must not claim
  // it is permanent (blocked) nor that we failed to ask (never_asked).
  return 'denied';
}
