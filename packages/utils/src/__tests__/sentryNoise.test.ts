import { describe, it, expect } from 'vitest';
import {
  BENIGN_CONSOLE_PATTERNS,
  BENIGN_REJECTION_PATTERNS,
  BENIGN_NETWORK_PATTERNS,
  BENIGN_INAPP_BROWSER_PATTERNS,
  SENTRY_IGNORE_PATTERNS,
  SENTRY_DENY_URLS,
  isBenignSentryMessage,
  makeSentryBeforeSend,
} from '../sentryNoise';

describe('isBenignSentryMessage', () => {
  it('matches transient network errors (very common in Cuba)', () => {
    expect(isBenignSentryMessage('Network request failed')).toBe(true);
    expect(isBenignSentryMessage('TypeError: Network request failed')).toBe(true);
    expect(isBenignSentryMessage('Failed to fetch')).toBe(true);
    expect(isBenignSentryMessage('Load failed')).toBe(true);
    expect(isBenignSentryMessage('AbortError: The operation was aborted')).toBe(true);
    expect(isBenignSentryMessage('NetworkError when attempting to fetch resource.')).toBe(true);
    expect(isBenignSentryMessage('TimeoutError')).toBe(true);
  });

  it('matches the benign runtime warnings already silenced by setupRuntimeLogging', () => {
    // Regression guard: these are the exact strings the native console
    // silencer drops. They must stay in sync via this shared module.
    expect(isBenignSentryMessage('SafeAreaView has been deprecated and will be removed')).toBe(true);
    expect(isBenignSentryMessage('[expo-av]: Expo AV has been deprecated')).toBe(true);
    expect(
      isBenignSentryMessage('[expo-notifications] Error thrown while updating the device push token'),
    ).toBe(true);
    expect(
      isBenignSentryMessage("Call to function 'ExpoKeepAwake.activate' has been rejected"),
    ).toBe(true);
    expect(isBenignSentryMessage('The current activity is no longer available')).toBe(true);
  });

  it('matches the JS that in-app browsers inject into the page', () => {
    // Real Sentry issue TRICIGO-WEB-T (2026-07-29): the Instagram in-app
    // WKWebView injects its own tracking script into tricigo.com (traffic from
    // the link-in-bio). On pagehide that script calls its native bridge, which
    // is already gone. `window.onerror` catches it and files it against us.
    expect(
      isBenignSentryMessage(
        "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      ),
    ).toBe(true);
    // Same failure on Chromium-based in-app browsers (different wording).
    expect(
      isBenignSentryMessage("Cannot read properties of undefined (reading 'messageHandlers')"),
    ).toBe(true);
  });

  it('does NOT match genuine application errors (no false silencing)', () => {
    expect(isBenignSentryMessage("Cannot read property 'foo' of undefined")).toBe(false);
    expect(isBenignSentryMessage('Payment failed: insufficient funds')).toBe(false);
    expect(isBenignSentryMessage('User cancelled the ride')).toBe(false);
    expect(isBenignSentryMessage('Transaction aborted by user')).toBe(false); // not a fetch abort
    expect(isBenignSentryMessage('Payment timed out waiting for driver')).toBe(false);
    expect(isBenignSentryMessage('')).toBe(false);
  });
});

describe('pattern arrays', () => {
  it('SENTRY_IGNORE_PATTERNS is the union of runtime + network + in-app-browser patterns', () => {
    const expected = new Set([
      ...BENIGN_CONSOLE_PATTERNS,
      ...BENIGN_REJECTION_PATTERNS,
      ...BENIGN_NETWORK_PATTERNS,
      ...BENIGN_INAPP_BROWSER_PATTERNS,
    ]);
    expect(SENTRY_IGNORE_PATTERNS.length).toBe(expected.size);
    for (const p of SENTRY_IGNORE_PATTERNS) expect(expected.has(p)).toBe(true);
  });

  it('SENTRY_DENY_URLS covers browser-extension noise (web/admin)', () => {
    const hit = (url: string) => SENTRY_DENY_URLS.some((re) => re.test(url));
    expect(hit('chrome-extension://abcdef/inject.js')).toBe(true);
    expect(hit('moz-extension://abcdef/inject.js')).toBe(true);
    expect(hit('https://tricigo.com/_next/static/chunks/page.js')).toBe(false);
  });
});

describe('makeSentryBeforeSend', () => {
  const beforeSend = makeSentryBeforeSend();

  it('drops an event whose originalException is a benign network error', () => {
    const event = { exception: { values: [{ type: 'TypeError', value: 'Network request failed' }] } };
    const result = beforeSend(event, { originalException: new Error('Network request failed') });
    expect(result).toBeNull();
  });

  it('drops an event whose exception value is benign even without a hint', () => {
    const event = { exception: { values: [{ type: 'Error', value: 'Failed to fetch' }] } };
    expect(beforeSend(event, undefined)).toBeNull();
  });

  it('drops an event whose top-level message is benign', () => {
    expect(beforeSend({ message: 'AbortError: aborted a request' }, undefined)).toBeNull();
  });

  it('drops the real Instagram in-app browser event (TRICIGO-WEB-T)', () => {
    // Verbatim shape of the production event that triggered the alert email.
    const event = {
      exception: {
        values: [
          {
            type: 'TypeError',
            value: "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
          },
        ],
      },
    };
    expect(beforeSend(event, undefined)).toBeNull();
  });

  it('keeps a genuine application error', () => {
    const event = { exception: { values: [{ type: 'TypeError', value: "Cannot read property 'x' of undefined" }] } };
    const result = beforeSend(event, { originalException: new Error("Cannot read property 'x' of undefined") });
    expect(result).toBe(event);
  });

  it('scrubs the Authorization header from kept events (any casing)', () => {
    const event = {
      message: 'Genuine error',
      request: { headers: { Authorization: 'Bearer secret', authorization: 'Bearer secret2', 'X-Foo': 'ok' } },
    };
    const result = beforeSend(event, undefined) as typeof event;
    expect(result).not.toBeNull();
    expect(result.request.headers.Authorization).toBeUndefined();
    expect(result.request.headers.authorization).toBeUndefined();
    expect(result.request.headers['X-Foo']).toBe('ok');
  });

  it('returns the event unchanged when there is nothing to scrub or drop', () => {
    const event = { message: 'Genuine error' };
    expect(beforeSend(event, undefined)).toBe(event);
  });

  it('does not crash on an empty/partial event', () => {
    expect(() => beforeSend({}, undefined)).not.toThrow();
    expect(beforeSend({}, undefined)).toEqual({});
  });

  it('honors extra patterns passed by the caller', () => {
    const withExtra = makeSentryBeforeSend([/MyCustomBenign/]);
    expect(withExtra({ message: 'MyCustomBenign thing happened' }, undefined)).toBeNull();
    // default beforeSend should NOT drop it
    expect(beforeSend({ message: 'MyCustomBenign thing happened' }, undefined)).not.toBeNull();
  });
});
