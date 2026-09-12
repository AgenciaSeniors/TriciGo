import { describe, it, expect } from 'vitest';
import {
  classifyPushPermission,
  describePushError,
  isRetryablePushTokenError,
  pushTokenRetryDelayMs,
  shouldSpendPushPrompt,
  PUSH_DETAIL_MAX_LEN,
  PUSH_TOKEN_MAX_ATTEMPTS,
  shouldFallbackToProxy,
} from '../pushRegistration';

describe('classifyPushPermission — why a device has no push token', () => {
  it('reports granted when the OS permission is already given', () => {
    expect(classifyPushPermission({ status: 'granted', canAskAgain: true })).toBe('granted');
    // Granted wins even if the OS says it would not ask again — there is
    // nothing left to ask for.
    expect(classifyPushPermission({ status: 'granted', canAskAgain: false })).toBe('granted');
  });

  it('reports never_asked while the permission is still undetermined', () => {
    // Android 13+ / iOS before the one-shot dialog has been spent. This is the
    // outcome that means WE have a problem: nobody ever put the question to
    // the user, so a missing token is our fault, not their choice.
    expect(classifyPushPermission({ status: 'undetermined', canAskAgain: true })).toBe('never_asked');
  });

  it('reports blocked when the OS will never prompt again', () => {
    // Android 13+ marks POST_NOTIFICATIONS permanently denied after the first
    // refusal. Only system Settings can undo it, so the app must stop asking
    // and start deep-linking.
    expect(classifyPushPermission({ status: 'denied', canAskAgain: false })).toBe('blocked');
  });

  it('reports denied when the user refused but the OS would still ask', () => {
    expect(classifyPushPermission({ status: 'denied', canAskAgain: true })).toBe('denied');
  });

  it('treats an unaskable permission as blocked whatever the status string says', () => {
    // canAskAgain is the load-bearing field: it decides whether a prompt can
    // still recover the user. Trust it over an unfamiliar status.
    expect(classifyPushPermission({ status: 'undetermined', canAskAgain: false })).toBe('blocked');
  });

  it('falls back to denied on a missing or unknown snapshot', () => {
    // Never invent 'never_asked' (which would read as our bug) or 'blocked'
    // (which would read as permanent) out of missing data.
    expect(classifyPushPermission({})).toBe('denied');
    expect(classifyPushPermission({ status: null, canAskAgain: null })).toBe('denied');
    expect(classifyPushPermission({ status: 'provisional' })).toBe('denied');
  });
});

describe('shouldSpendPushPrompt — when the app may spend its one OS prompt', () => {
  it('spends it exactly once, while the question has never been put', () => {
    // Android 13+ shows POST_NOTIFICATIONS once per install. `undetermined`
    // is the only state in which asking can still produce a grant.
    expect(shouldSpendPushPrompt({ status: 'undetermined', canAskAgain: true })).toBe(true);
  });

  it('does not ask someone who already said yes', () => {
    expect(shouldSpendPushPrompt({ status: 'granted', canAskAgain: true })).toBe(false);
    expect(shouldSpendPushPrompt({ status: 'granted', canAskAgain: false })).toBe(false);
  });

  it('does not fire a silent no-op at someone who already refused', () => {
    // After a denial the OS dialog never appears again: requestPermissions
    // resolves instantly with the same denial and the user sees NOTHING.
    // Those users need the Settings deep-link, not another silent request.
    expect(shouldSpendPushPrompt({ status: 'denied', canAskAgain: false })).toBe(false);
    expect(shouldSpendPushPrompt({ status: 'denied', canAskAgain: true })).toBe(false);
  });

  it('stays silent when the OS says it will not ask again, whatever the status', () => {
    // canAskAgain is the load-bearing field. An unfamiliar status plus
    // "won't ask again" must never be read as an opportunity.
    expect(shouldSpendPushPrompt({ status: 'undetermined', canAskAgain: false })).toBe(false);
  });

  it('stays silent on a missing or unknown snapshot', () => {
    // Never spend the one-shot prompt on a guess.
    expect(shouldSpendPushPrompt({})).toBe(false);
    expect(shouldSpendPushPrompt({ status: null, canAskAgain: null })).toBe(false);
    expect(shouldSpendPushPrompt({ status: 'provisional' })).toBe(false);
  });
});

describe('describePushError — what we get to read when the token fetch fails', () => {
  it('prefixes the Expo error code so causes group without parsing the body', () => {
    // The 403 that started this arrives as a CodedError whose message is a
    // whole HTML page. The code is the only structured thing in it.
    const err = Object.assign(new Error('403 (body: "<html>…")'), {
      code: 'ERR_NOTIFICATIONS_SERVER_ERROR',
    });
    expect(describePushError(err)).toBe('[ERR_NOTIFICATIONS_SERVER_ERROR] 403 (body: "<html>…")');
  });

  it('falls back to the bare message when there is no code', () => {
    expect(describePushError(new Error('boom'))).toBe('boom');
  });

  it('survives being handed something that is not an Error', () => {
    // This runs inside a catch: it must never throw on its way to reporting.
    expect(describePushError('just a string')).toBe('just a string');
    expect(describePushError(null)).toBe('null');
    expect(describePushError(undefined)).toBe('undefined');
  });

  it('does not truncate — the cap belongs to the single write choke point', () => {
    // recordPushRegistration caps it once, matching the DB CHECK. Cutting it
    // here too would mean two numbers to keep in sync and a silent mismatch.
    const long = 'x'.repeat(PUSH_DETAIL_MAX_LEN + 500);
    expect(describePushError(new Error(long))).toHaveLength(long.length);
  });
});

describe('PUSH_DETAIL_MAX_LEN — must equal the DB CHECK', () => {
  it('is 2000, the value migration 00586 enforces', () => {
    // If these ever disagree the upsert fails and recordPushRegistration
    // swallows it — the row is lost entirely, which is worse than truncation.
    expect(PUSH_DETAIL_MAX_LEN).toBe(2000);
  });

  it('leaves room for a full Google Cloud 403 page', () => {
    // The body that got cut at 300 was ~500 chars of boilerplate HTML plus the
    // wrapper message. 2000 keeps the whole thing.
    expect(PUSH_DETAIL_MAX_LEN).toBeGreaterThan(1000);
  });
});

describe('isRetryablePushTokenError — what deserves another attempt', () => {
  it('retries the Cuban 403 from exp.host', () => {
    // A server decision, so isNetworkError() says false — but it is exactly
    // the case worth retrying, because the block is partial/intermittent.
    const err = Object.assign(new Error('403 Forbidden'), {
      code: 'ERR_NOTIFICATIONS_SERVER_ERROR',
    });
    expect(isRetryablePushTokenError(err)).toBe(true);
  });

  it('retries a plain network failure', () => {
    const err = Object.assign(new Error('Network request failed'), {
      code: 'ERR_NOTIFICATIONS_NETWORK_ERROR',
    });
    expect(isRetryablePushTokenError(err)).toBe(true);
  });

  it('does NOT retry a missing projectId — no attempt can fix config', () => {
    const err = Object.assign(new Error('No "projectId" found'), {
      code: 'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID',
    });
    expect(isRetryablePushTokenError(err)).toBe(false);
  });

  it('does NOT retry a missing applicationId', () => {
    const err = Object.assign(new Error('No "applicationId" found'), {
      code: 'ERR_NOTIFICATIONS_NO_APPLICATION_ID',
    });
    expect(isRetryablePushTokenError(err)).toBe(false);
  });

  it('retries anything it does not recognise', () => {
    // The lesson of this very bug: the real failure mode was not on anyone's
    // list. An allowlist would have refused to retry the one case that mattered.
    expect(isRetryablePushTokenError(new Error('something new'))).toBe(true);
    expect(isRetryablePushTokenError('a string')).toBe(true);
    expect(isRetryablePushTokenError(null)).toBe(true);
    expect(isRetryablePushTokenError(Object.assign(new Error('x'), { code: 'ERR_UNHEARD_OF' }))).toBe(true);
  });
});

describe('pushTokenRetryDelayMs — backoff between attempts', () => {
  it('waits longer on each successive attempt', () => {
    expect(pushTokenRetryDelayMs(0)).toBe(800);
    expect(pushTokenRetryDelayMs(1)).toBe(2400);
  });

  it('grows monotonically and never returns a negative wait', () => {
    let previous = -1;
    for (let attempt = 0; attempt < PUSH_TOKEN_MAX_ATTEMPTS; attempt += 1) {
      const delay = pushTokenRetryDelayMs(attempt);
      expect(delay).toBeGreaterThan(previous);
      expect(delay).toBeGreaterThanOrEqual(0);
      previous = delay;
    }
  });

  it('keeps the whole retry budget short enough to stay out of the way', () => {
    // This runs during app start. Three attempts must not add seconds of
    // background work that outlive the screen the user is looking at.
    let total = 0;
    for (let attempt = 0; attempt < PUSH_TOKEN_MAX_ATTEMPTS - 1; attempt += 1) {
      total += pushTokenRetryDelayMs(attempt);
    }
    expect(total).toBeLessThanOrEqual(5000);
  });
});

describe('PUSH_TOKEN_MAX_ATTEMPTS', () => {
  it('gives an intermittent block more than one chance, without hammering', () => {
    expect(PUSH_TOKEN_MAX_ATTEMPTS).toBe(3);
  });
});

// The retry shipped in #1000 assumed the Cuban 403 was intermittent. It is not:
// measured 2026-09-12, 9 of the 10 drivers hitting it had NEVER held a token.
// Three attempts in ~3 s against a stable edge denial fail three times, so the
// only thing that rescues them is asking a machine Expo will actually answer.
describe('shouldFallbackToProxy', () => {
  it('falls back on the Cuban 403 — the case the proxy exists for', () => {
    const err = Object.assign(
      new Error('Error encountered while fetching Expo token, expected an OK response, received: 403'),
      { code: 'ERR_NOTIFICATIONS_SERVER_ERROR' },
    );
    expect(shouldFallbackToProxy(err)).toBe(true);
  });

  it('falls back on an error nobody has seen yet', () => {
    // Same reasoning as isRetryablePushTokenError: deny-list, not allow-list.
    // An allow-list would have refused the one failure that actually happened.
    expect(shouldFallbackToProxy(new Error('something new'))).toBe(true);
    expect(shouldFallbackToProxy(undefined)).toBe(true);
  });

  it('does NOT fall back on a misconfiguration the proxy cannot fix', () => {
    // A missing projectId is missing on the proxy too. Retrying it there only
    // costs the user a round trip before the same failure.
    for (const code of ['ERR_NOTIFICATIONS_NO_EXPERIENCE_ID', 'ERR_NOTIFICATIONS_NO_APPLICATION_ID']) {
      expect(shouldFallbackToProxy(Object.assign(new Error('x'), { code }))).toBe(false);
    }
  });

  it('agrees with isRetryablePushTokenError — one policy, not two', () => {
    // If these ever diverge, an error would be retried but not proxied (or the
    // reverse) and the reason would live in nobody's head.
    const cases: unknown[] = [
      new Error('plain'),
      Object.assign(new Error('a'), { code: 'ERR_NOTIFICATIONS_SERVER_ERROR' }),
      Object.assign(new Error('b'), { code: 'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID' }),
      Object.assign(new Error('c'), { code: 'ERR_NOTIFICATIONS_NO_APPLICATION_ID' }),
      null,
    ];
    for (const err of cases) {
      expect(shouldFallbackToProxy(err)).toBe(isRetryablePushTokenError(err));
    }
  });
});
