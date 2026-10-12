import * as Sentry from '@sentry/nextjs';
import { SENTRY_IGNORE_PATTERNS, makeSentryBeforeSend } from '@tricigo/utils/sentryNoise';
import { scrubUrlSecrets } from '@tricigo/utils/sentryPrivacy';

export const onRequestError = Sentry.captureRequestError;

// Drops benign noise and scrubs Authorization (shared with the other apps, sentryNoise.ts).
const dropNoise = makeSentryBeforeSend();

// The server keeps the raw path and query of every request (http.target, url.query, request.url) and
// its headers (referer, next-url, next-router-state-tree): the trip share token and the e-mail
// confirmation token reach Sentry through them. scrubUrlSecrets removes them (sentryPrivacy.ts).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const Sentry = await import('@sentry/nextjs');
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (dsn) {
      Sentry.init({
        dsn,
        environment: process.env.NODE_ENV,
        tracesSampleRate: 0.2,
        ignoreErrors: SENTRY_IGNORE_PATTERNS,
        beforeSend: (event, hint) => {
          const kept = dropNoise(event, hint);
          return kept && scrubUrlSecrets(kept);
        },
        beforeSendTransaction: (event) => scrubUrlSecrets(event),
      });
    }
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    const Sentry = await import('@sentry/nextjs');
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (dsn) {
      Sentry.init({
        dsn,
        environment: process.env.NODE_ENV,
        tracesSampleRate: 0.2,
        ignoreErrors: SENTRY_IGNORE_PATTERNS,
        beforeSend: (event, hint) => {
          const kept = dropNoise(event, hint);
          return kept && scrubUrlSecrets(kept);
        },
        beforeSendTransaction: (event) => scrubUrlSecrets(event),
      });
    }
  }
}
