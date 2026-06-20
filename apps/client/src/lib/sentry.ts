import * as Sentry from '@sentry/react-native';
import { SENTRY_IGNORE_PATTERNS, makeSentryBeforeSend } from '@tricigo/utils/sentryNoise';

const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

export function initSentry() {
  if (!SENTRY_DSN) {
    console.log('[Sentry] No DSN configured, skipping initialization');
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: __DEV__ ? 'development' : 'production',
    // Only report from production builds — dev errors (fast-refresh, transient
    // red-screens) must not flood the prod Sentry project. Matches the driver.
    enabled: !__DEV__,
    tracesSampleRate: 0.2,
    sendDefaultPii: false,
    // Drop benign network/connectivity noise (constant in Cuba) + upstream
    // Expo deprecations, and scrub the Authorization header. Shared with the
    // other apps and with the native console silencer (sentryNoise.ts).
    ignoreErrors: SENTRY_IGNORE_PATTERNS,
    beforeSend: makeSentryBeforeSend(),
  });
}

export { Sentry };
