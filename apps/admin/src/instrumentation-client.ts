import * as Sentry from '@sentry/nextjs';
import { SENTRY_IGNORE_PATTERNS, SENTRY_DENY_URLS, makeSentryBeforeSend } from '@tricigo/utils/sentryNoise';

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.2,
    replaysSessionSampleRate: 0,
    // Lowered from 1.0 — a replay on EVERY error is costly at scale. Notifs are
    // unaffected (replays attach to existing issues, they don't create new ones).
    replaysOnErrorSampleRate: 0.3,
    // Drop benign network noise + upstream deprecations, ignore browser-extension
    // errors, and scrub Authorization. Shared with the other apps (sentryNoise.ts).
    ignoreErrors: SENTRY_IGNORE_PATTERNS,
    denyUrls: SENTRY_DENY_URLS,
    beforeSend: makeSentryBeforeSend(),
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
