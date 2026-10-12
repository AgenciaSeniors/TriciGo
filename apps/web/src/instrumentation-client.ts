import * as Sentry from '@sentry/nextjs';
import { SENTRY_IGNORE_PATTERNS, SENTRY_DENY_URLS, makeSentryBeforeSend } from '@tricigo/utils/sentryNoise';
import { scrubUrlSecrets } from '@tricigo/utils/sentryPrivacy';

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

// Drops benign noise and scrubs Authorization (shared with the other apps, sentryNoise.ts).
const dropNoise = makeSentryBeforeSend();

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
    // URLs carry secrets here: the Supabase session in the fragment after Google/Apple and the e-mail
    // login link (/auth/callback#access_token=…&refresh_token=…), the team digest opt-out token, the
    // trip share token in the path (/track/share/<token>) and the e-mail confirmation token in the
    // query. The SDK copies the page URL into errors, transactions, breadcrumbs and the standalone INP
    // span (the pageload transaction keeps location.href from SDK init, before GoTrue clears the hash):
    // scrubUrlSecrets removes them from every kind of event (sentryPrivacy.ts).
    beforeSend: (event, hint) => {
      const kept = dropNoise(event, hint);
      return kept && scrubUrlSecrets(kept);
    },
    beforeSendTransaction: (event) => scrubUrlSecrets(event),
    beforeSendSpan: (span) => scrubUrlSecrets(span),
  });
}

// Navigation instrumentation for Next.js App Router
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
