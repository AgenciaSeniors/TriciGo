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

/**
 * How much of an error message survives into `push_registration_status.detail`.
 *
 * **This number is duplicated in the database on purpose and MUST match it**
 * (`push_registration_status_detail_len`, migration 00586). If the app ever
 * sends more than the CHECK allows, the upsert fails, `recordPushRegistration`
 * logs and swallows it, and the row is lost ENTIRELY — strictly worse than the
 * truncation it was meant to avoid.
 *
 * Why it moved from 300 to 2000: the first `error` row ever recorded was a 403
 * from `exp.host` whose body is a full Google Cloud denial page. At 300 it was
 * cut mid-sentence, and the diagnosis had to be rebuilt by reading the Expo
 * source. One row per (user, app) — the storage is irrelevant, the evidence
 * is not.
 */
export const PUSH_DETAIL_MAX_LEN = 2000;

/** Attempts (1 initial + retries) at minting the Expo token. */
export const PUSH_TOKEN_MAX_ATTEMPTS = 3;

/**
 * Expo error codes that no number of attempts can fix.
 *
 * Both are configuration, not connectivity: the value is missing from the
 * build, so the next attempt reads the same missing value.
 */
const PERMANENT_PUSH_TOKEN_ERROR_CODES = new Set([
  'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID',
  'ERR_NOTIFICATIONS_NO_APPLICATION_ID',
]);

/** Reads `CodedError.code` off an unknown throw without assuming its shape. */
function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * Turn whatever was thrown into the line we will get to read months later.
 *
 * Prefixes the Expo `code` when there is one, so causes group by something
 * structured instead of by parsing an HTML body.
 *
 * Deliberately does NOT truncate: the cap lives at the single write choke
 * point (`recordPushRegistration`), where it can stay in step with the DB
 * CHECK. Two places to cut means two numbers to keep in sync.
 */
export function describePushError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = errorCode(err);
  return code ? `[${code}] ${message}` : message;
}

/**
 * Is this failure worth another attempt?
 *
 * **Deny-list, not allow-list, and that is the whole point.** The failure that
 * prompted this — a 403 from Google Cloud's edge in front of `exp.host`, seen
 * from a Cuban IP — was on nobody's list of expected errors. An allow-list
 * would have refused to retry the one case that mattered. So everything is
 * retryable except the two codes that retrying provably cannot change.
 *
 * Note this cannot be `isNetworkError` from './networkError': a 403 is a
 * decision the server made, so that helper correctly returns false for it.
 * Here we want it retried, because the block is partial and intermittent —
 * 37 of 143 drivers hold a token and new ones still arrive daily.
 */
export function isRetryablePushTokenError(err: unknown): boolean {
  const code = errorCode(err);
  return code === null || !PERMANENT_PUSH_TOKEN_ERROR_CODES.has(code);
}

/**
 * Backoff before the attempt after `attempt` (0-based).
 *
 * Kept short on purpose: this runs during app start, and the whole budget has
 * to finish well inside the time the person spends on the first screen.
 */
export function pushTokenRetryDelayMs(attempt: number): number {
  return 800 * 3 ** attempt;
}
