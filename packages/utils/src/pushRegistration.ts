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

/**
 * May the app spend its one OS permission prompt right now?
 *
 * MEASURED 2026-09-10, share of users holding a push token within 7 days of
 * signing up (same window for every cohort, so exposure is not the variable):
 *
 *   June  50 % (n=12)   July 24 % (n=302)   August 7 % (n=209)   Sept 7 % (n=14)
 *
 * Both roles fell together, which rules out an app-specific bug. What changed
 * at that boundary is that the app stopped asking: an unconditional
 * `requestPermissionsAsync()` on first launch was replaced by a soft-ask sheet
 * alone. The sheet is good at recovery — it deep-links to Settings, which is
 * the only way back after a denial — but as the ONLY asker it collects a third
 * of the grants, because it costs two taps and a modal is easy to wave away.
 *
 * So the app asks again. Not the way July did, though: July asked at cold
 * mount with no session, before the person had signed up or seen a screen, and
 * its own code comment records the result — "three quarters of them denied it
 * for good". This gate is the difference. It says yes only while `undetermined`,
 * so the prompt is spent at most once, and only on a state where a grant is
 * still reachable. Everything else is left to the sheet.
 *
 * Never returns true for a denial: after one, `requestPermissionsAsync()`
 * resolves instantly with the same answer and the user sees nothing at all.
 * Firing it there would look like a working ask while collecting zero grants.
 */
export function shouldSpendPushPrompt(snapshot: PushPermissionSnapshot): boolean {
  return classifyPushPermission(snapshot) === 'never_asked';
}
