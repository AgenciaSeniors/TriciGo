/**
 * Shared Sentry noise filtering — single source of truth.
 *
 * Platform-neutral (NO React Native or Next.js imports) so it can be consumed
 * by BOTH `@sentry/react-native` (apps/client, apps/driver) and
 * `@sentry/nextjs` (apps/web, apps/admin) `Sentry.init` configs, AND by the
 * native console silencer in `setupRuntimeLogging.native.ts`. Keeping the
 * regex patterns here means the dev-console silencing and the Sentry event
 * filtering can never drift apart.
 *
 * Why this exists: the user was getting flooded with Sentry notifications.
 * In Cuba's low-connectivity environment, transient network errors
 * (`Network request failed`, fetch aborts, timeouts) are constant and benign
 * — they should not create Sentry issues. Same for a handful of upstream
 * Expo/RN deprecation warnings we don't control.
 */

/**
 * Benign console warnings (matched against `console.warn`/`console.error`
 * messages). These mirror what `setupRuntimeLogging.native.ts` silences via
 * `LogBox.ignoreLogs`. Patterns must be specific — strict literal prefixes.
 */
export const BENIGN_CONSOLE_PATTERNS: RegExp[] = [
  /SafeAreaView has been deprecated/,
  /\[expo-av\]:?\s+Expo AV has been deprecated/,
  /\[expo-notifications\] Error thrown while updating the device push token/,
];

/**
 * Benign unhandled-promise-rejection messages (Expo lifecycle races that do
 * NOT crash the app). Mirrors the native rejection tracker's allow-list.
 */
export const BENIGN_REJECTION_PATTERNS: RegExp[] = [
  /Call to function 'ExpoKeepAwake\.activate' has been rejected/,
  /The current activity is no longer available/,
];

/**
 * Transient network/connectivity errors. Very common in Cuba (flaky links,
 * captive portals, backgrounded sockets) and almost never an actionable bug.
 * Kept deliberately specific to fetch/network failures so we don't silence
 * genuine application logic that merely contains the words "aborted"/"timed
 * out" (e.g. "Transaction aborted by user", "Payment timed out").
 */
export const BENIGN_NETWORK_PATTERNS: RegExp[] = [
  /Network request failed/i,
  /Failed to fetch/i,
  /Load failed/i,
  /NetworkError\b/i,
  /\bAbortError\b/i,
  /aborted a request/i,
  /the operation was aborted/i,
  /signal is aborted without reason/i,
  /TimeoutError\b/i,
  /\bETIMEDOUT\b/i,
  /\bECONNRESET\b/i,
  /\bECONNABORTED\b/i,
  /\bENOTFOUND\b/i,
  /\bERR_NETWORK\b/i,
  /ERR_INTERNET_DISCONNECTED/i,
  /Connection (?:refused|reset|closed)/i,
];

/** All patterns to feed into `Sentry.init({ ignoreErrors })`. */
export const SENTRY_IGNORE_PATTERNS: RegExp[] = [
  ...BENIGN_CONSOLE_PATTERNS,
  ...BENIGN_REJECTION_PATTERNS,
  ...BENIGN_NETWORK_PATTERNS,
];

/**
 * URLs to feed into `Sentry.init({ denyUrls })` (web/admin only). Drops errors
 * originating from browser extensions injected into the page — pure noise.
 */
export const SENTRY_DENY_URLS: RegExp[] = [
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-(?:web-)?extension:\/\//i,
  /\/extensions\//i,
];

/** Returns true if a message matches any benign pattern (case as authored). */
export function isBenignSentryMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return SENTRY_IGNORE_PATTERNS.some((re) => re.test(message));
}

/** Minimal shape of a Sentry event — avoids depending on @sentry/* in utils. */
export interface MinimalSentryEvent {
  message?: string;
  exception?: { values?: Array<{ type?: string; value?: string }> };
  request?: { headers?: Record<string, string> };
}

/** Minimal shape of the Sentry beforeSend hint. */
export interface MinimalSentryHint {
  originalException?: unknown;
}

function messageOf(err: unknown): string {
  if (!err) return '';
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && 'message' in err) {
    return String((err as { message?: unknown }).message ?? '');
  }
  return String(err);
}

/**
 * Builds a `beforeSend` callback shared by all four apps. It:
 *  1. Drops events whose error message matches a benign pattern (network noise
 *     + upstream deprecations) → no Sentry issue, no notification.
 *  2. Scrubs the `Authorization` header from any kept event (defence in depth;
 *     `sendDefaultPii` is already false).
 *
 * @param extraPatterns app-specific patterns to additionally ignore.
 */
export function makeSentryBeforeSend(extraPatterns: RegExp[] = []) {
  const patterns = [...SENTRY_IGNORE_PATTERNS, ...extraPatterns];
  const isBenign = (msg: string): boolean => !!msg && patterns.some((re) => re.test(msg));

  return function beforeSend<E extends MinimalSentryEvent>(
    event: E,
    hint?: MinimalSentryHint,
  ): E | null {
    // Gather every candidate message attached to this event.
    const candidates: string[] = [];
    if (hint?.originalException) candidates.push(messageOf(hint.originalException));
    for (const v of event.exception?.values ?? []) {
      if (v?.value) candidates.push(v.value);
    }
    if (event.message) candidates.push(event.message);

    if (candidates.some(isBenign)) return null;

    // Scrub Authorization header (any casing) from kept events.
    const headers = event.request?.headers;
    if (headers) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'authorization') delete headers[key];
      }
    }
    return event;
  };
}
