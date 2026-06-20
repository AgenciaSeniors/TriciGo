/**
 * Runtime logging setup — native implementation.
 *
 * Silences 4 known-benign runtime warnings/errors that flood the dev console
 * on every cold-start of the driver and client apps. Each one is either an
 * Expo SDK internal issue or an upstream third-party deprecation that we
 * don't control and that does NOT crash the app:
 *
 *   1. `Uncaught (in promise) Error: Call to function 'ExpoKeepAwake.activate'
 *      has been rejected → Caused by: The current activity is no longer available`
 *      — Race condition in Expo's KeepAwake module during Android lifecycle
 *      transitions (background → foreground, post-deep-link redirect). The
 *      Promise rejection escapes and prints a noisy stack trace, but the JS
 *      bridge keeps running.
 *
 *   2. `[expo-av]: Expo AV has been deprecated and will be removed in SDK 54`
 *      — `packages/utils/src/sounds.native.ts` still uses `Audio.Sound` from
 *      `expo-av`. Migration to `expo-audio` is tracked as a follow-up PR
 *      (requires rebuild APK).
 *
 *   3. `SafeAreaView has been deprecated and will be removed in a future
 *      release. Please use 'react-native-safe-area-context' instead`
 *      — Comes from NativeWind v4 (`react-native-css-interop`), which still
 *      imports the deprecated RN SafeAreaView internally. NOT our code; waits
 *      on upstream NativeWind fix.
 *
 *   4. `[expo-notifications] Error thrown while updating the device push
 *      token with the server: TypeError: Network request failed`
 *      — `expo-notifications` auto-registers the push token against
 *      exp.host/--/api/v2/push on cold-start. If the device has no internet,
 *      a VPN/firewall blocking the endpoint, or the EAS push config is
 *      incomplete, the request fails and prints this error. Benign because
 *      the SDK retries on next cold-start.
 *
 * The web stub (`setupRuntimeLogging.ts`) is a no-op — LogBox doesn't exist
 * on web and the warnings don't apply.
 */

import { LogBox } from 'react-native';
// Single source of truth shared with the Sentry event filter (sentryNoise.ts)
// so the dev-console silencing and Sentry's `ignoreErrors` can never drift.
import { BENIGN_CONSOLE_PATTERNS, BENIGN_REJECTION_PATTERNS } from './sentryNoise';

/**
 * Regex patterns matched against the message of a `console.warn` or
 * `console.error` call. If matched, the warning is silenced via
 * `LogBox.ignoreLogs`. Patterns must be specific enough to avoid silencing
 * legitimate errors — strict literal-match prefixes only.
 */
const SILENCED_PATTERNS: RegExp[] = BENIGN_CONSOLE_PATTERNS;

/**
 * Regex patterns matched against unhandled Promise rejection messages.
 * Matched rejections are silently dropped; unmatched ones still print to
 * the console (preserving visibility of real bugs).
 */
const SILENCED_PROMISE_REJECTIONS: RegExp[] = BENIGN_REJECTION_PATTERNS;

type HermesPromiseTracker = {
  enablePromiseRejectionTracker?: (opts: {
    allRejections: boolean;
    onUnhandled: (id: number, err: unknown) => void;
  }) => void;
};

export function setupRuntimeLogging(): void {
  // 1. Suppress matched console warnings via LogBox.
  LogBox.ignoreLogs(SILENCED_PATTERNS.map((p) => p.source));

  // 2. Hook into the Hermes promise rejection tracker (RN ≥ 0.70 on
  //    Android/iOS) to swallow known-benign rejections without affecting
  //    legitimate ones.
  const g = global as unknown as { HermesInternal?: HermesPromiseTracker };
  const tracker = g.HermesInternal?.enablePromiseRejectionTracker;
  if (typeof tracker !== 'function') return;

  const isBenign = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    return SILENCED_PROMISE_REJECTIONS.some((p) => p.test(msg));
  };

  tracker({
    allRejections: true,
    onUnhandled: (id, err) => {
      if (isBenign(err)) return;
      // eslint-disable-next-line no-console
      console.warn(`Unhandled promise rejection (id=${id})`, err);
    },
  });
}
