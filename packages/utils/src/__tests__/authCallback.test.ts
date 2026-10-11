import { describe, expect, it } from 'vitest';
import {
  PENDING_LOGIN_TTL_MS,
  authAccountLabel,
  decideAuthCallback,
  decodeAuthTokenClaims,
  parseAuthCallbackUrl,
  parsePendingLogin,
  serializePendingLogin,
  shouldAcceptUrlSession,
} from '../authCallback';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.sig`;
}

const ATTACKER = '11111111-1111-4111-8111-111111111111';
const VICTIM = '22222222-2222-4222-8222-222222222222';
const freshExp = Math.floor(NOW / 1000) + 3600;

describe('parseAuthCallbackUrl', () => {
  const at = jwt({ sub: ATTACKER, exp: freshExp });

  it('reads the tokens of an exact <scheme>://auth/callback link', () => {
    expect(parseAuthCallbackUrl(`tricigo://auth/callback#access_token=${at}&refresh_token=rt1&type=magiclink`, ['tricigo']))
      .toEqual({ accessToken: at, refreshToken: 'rt1' });
  });

  it('accepts the driver scheme only when it is listed', () => {
    const url = `tricigo-driver://auth/callback#access_token=${at}&refresh_token=rt1`;
    expect(parseAuthCallbackUrl(url, ['tricigo-driver'])).not.toBeNull();
    expect(parseAuthCallbackUrl(url, ['tricigo'])).toBeNull();
  });

  it('rejects links that only contain "auth/callback" somewhere', () => {
    for (const url of [
      `tricigo://book?x=auth/callback#access_token=${at}&refresh_token=rt1`,
      `tricigo://gift/auth/callback#access_token=${at}&refresh_token=rt1`,
      `https://tricigo.com/app/client/auth/callback#access_token=${at}&refresh_token=rt1`,
      `tricigo://auth/callbackX#access_token=${at}&refresh_token=rt1`,
      `tricigo://evil/auth/callback#access_token=${at}&refresh_token=rt1`,
    ]) {
      expect(parseAuthCallbackUrl(url, ['tricigo'])).toBeNull();
    }
  });

  it('needs both tokens in the fragment', () => {
    expect(parseAuthCallbackUrl(`tricigo://auth/callback#access_token=${at}`, ['tricigo'])).toBeNull();
    expect(parseAuthCallbackUrl(`tricigo://auth/callback?access_token=${at}&refresh_token=rt1`, ['tricigo'])).toBeNull();
    expect(parseAuthCallbackUrl('tricigo://auth/callback', ['tricigo'])).toBeNull();
  });

  it('tolerates a query string before the fragment', () => {
    expect(parseAuthCallbackUrl(`tricigo://auth/callback?x=1#access_token=${at}&refresh_token=rt1`, ['tricigo']))
      .toEqual({ accessToken: at, refreshToken: 'rt1' });
  });
});

describe('decodeAuthTokenClaims', () => {
  it('reads sub, email, phone and exp without verifying the signature', () => {
    const claims = decodeAuthTokenClaims(jwt({ sub: VICTIM, email: 'Ana@Example.com', phone: '5355550100', exp: freshExp }));
    expect(claims).toEqual({ sub: VICTIM, email: 'Ana@Example.com', phone: '5355550100', exp: freshExp });
  });

  it('decodes UTF-8 claims', () => {
    expect(decodeAuthTokenClaims(jwt({ sub: VICTIM, email: 'josé@ejemplo.cu' }))?.email).toBe('josé@ejemplo.cu');
  });

  it('returns null for anything that is not a JWT with a sub', () => {
    expect(decodeAuthTokenClaims('nope')).toBeNull();
    expect(decodeAuthTokenClaims('a.b.c')).toBeNull();
    expect(decodeAuthTokenClaims(jwt({ email: 'x@y.z' }))).toBeNull();
    expect(decodeAuthTokenClaims(jwt({ sub: 42 }))).toBeNull();
    expect(decodeAuthTokenClaims(`x.${b64url('[1,2]')}.y`)).toBeNull();
  });
});

describe('authAccountLabel', () => {
  it('prefers a real email', () => {
    expect(authAccountLabel({ sub: VICTIM, email: 'ana@example.com', phone: '5355550100', exp: null })).toBe('ana@example.com');
  });

  it('shows the phone of a phone account, never its synthetic email', () => {
    expect(authAccountLabel({ sub: VICTIM, email: 'phone_5355550100@tricigo.app', phone: '5355550100', exp: null })).toBe('+5355550100');
    expect(authAccountLabel({ sub: VICTIM, email: 'phone_5355550100@tricigo.app', phone: null, exp: null })).toBe('+5355550100');
  });

  it('returns null when there is nothing to show', () => {
    expect(authAccountLabel({ sub: VICTIM, email: null, phone: null, exp: null })).toBeNull();
  });
});

describe('pending login marker', () => {
  it('round-trips', () => {
    expect(parsePendingLogin(serializePendingLogin('oauth', NOW))).toEqual({ kind: 'oauth', startedAt: NOW, expectedEmail: null });
    expect(parsePendingLogin(serializePendingLogin('email_link', NOW, '  Ana@Example.com '))).toEqual({
      kind: 'email_link',
      startedAt: NOW,
      expectedEmail: 'ana@example.com',
    });
  });

  it('rejects garbage', () => {
    for (const raw of [null, '', 'x', '{}', '{"kind":"other","startedAt":1}', '{"kind":"oauth","startedAt":"1"}', '[]']) {
      expect(parsePendingLogin(raw)).toBeNull();
    }
  });
});

describe('decideAuthCallback', () => {
  const attackerClaims = { sub: ATTACKER, email: 'phone_5399999999@tricigo.app', phone: '5399999999', exp: freshExp };
  const oauth = { kind: 'oauth' as const, startedAt: NOW - 60_000, expectedEmail: null };

  it('never replaces a session of another account', () => {
    expect(decideAuthCallback({ claims: attackerClaims, currentUserId: VICTIM, pending: null, now: NOW }))
      .toEqual({ action: 'ignore', reason: 'other_account_signed_in' });
    // Not even while a login the user started is pending.
    expect(decideAuthCallback({ claims: attackerClaims, currentUserId: VICTIM, pending: oauth, now: NOW }))
      .toEqual({ action: 'ignore', reason: 'other_account_signed_in' });
  });

  it('is a no-op for the account already signed in', () => {
    expect(decideAuthCallback({ claims: attackerClaims, currentUserId: ATTACKER, pending: null, now: NOW }))
      .toEqual({ action: 'ignore', reason: 'already_signed_in' });
  });

  it('accepts the login the user started on this device', () => {
    expect(decideAuthCallback({ claims: attackerClaims, currentUserId: null, pending: oauth, now: NOW }))
      .toEqual({ action: 'accept' });
  });

  it('asks when nobody started a login here', () => {
    expect(decideAuthCallback({ claims: attackerClaims, currentUserId: null, pending: null, now: NOW }))
      .toEqual({ action: 'confirm', accountLabel: '+5399999999' });
  });

  it('asks once the pending login is too old, or dated in the future', () => {
    const stale = { ...oauth, startedAt: NOW - PENDING_LOGIN_TTL_MS.oauth - 1 };
    expect(decideAuthCallback({ claims: attackerClaims, currentUserId: null, pending: stale, now: NOW }).action).toBe('confirm');
    const future = { ...oauth, startedAt: NOW + 5 * 60_000 };
    expect(decideAuthCallback({ claims: attackerClaims, currentUserId: null, pending: future, now: NOW }).action).toBe('confirm');
  });

  it('keeps an email link valid for its whole hour', () => {
    const emailLink = { kind: 'email_link' as const, startedAt: NOW - 50 * 60_000, expectedEmail: 'ana@example.com' };
    const ana = { sub: VICTIM, email: 'ANA@example.com', phone: null, exp: freshExp };
    expect(decideAuthCallback({ claims: ana, currentUserId: null, pending: emailLink, now: NOW })).toEqual({ action: 'accept' });
  });

  it('asks when the email link opens a different account than the one requested', () => {
    const emailLink = { kind: 'email_link' as const, startedAt: NOW - 60_000, expectedEmail: 'ana@example.com' };
    const other = { sub: ATTACKER, email: 'mallory@example.com', phone: null, exp: freshExp };
    expect(decideAuthCallback({ claims: other, currentUserId: null, pending: emailLink, now: NOW }))
      .toEqual({ action: 'confirm', accountLabel: 'mallory@example.com' });
  });

  it('ignores missing or expired tokens', () => {
    expect(decideAuthCallback({ claims: null, currentUserId: null, pending: oauth, now: NOW }))
      .toEqual({ action: 'ignore', reason: 'invalid_token' });
    const expired = { ...attackerClaims, exp: Math.floor(NOW / 1000) - 1 };
    expect(decideAuthCallback({ claims: expired, currentUserId: null, pending: oauth, now: NOW }))
      .toEqual({ action: 'ignore', reason: 'invalid_token' });
  });
});

describe('shouldAcceptUrlSession (web)', () => {
  const at = jwt({ sub: ATTACKER, exp: freshExp });
  const storedVictim = JSON.stringify({ access_token: 'x', refresh_token: 'y', user: { id: VICTIM } });

  it('accepts the redirect of a login started in this browser', () => {
    expect(shouldAcceptUrlSession({ access_token: at }, { pendingRaw: serializePendingLogin('oauth', NOW - 1000), storedSessionRaw: null, now: NOW }))
      .toBe(true);
  });

  it('refuses tokens nobody asked for, even with no session', () => {
    expect(shouldAcceptUrlSession({ access_token: at }, { pendingRaw: null, storedSessionRaw: null, now: NOW })).toBe(false);
  });

  it('refuses to replace the session of another account', () => {
    expect(shouldAcceptUrlSession({ access_token: at }, {
      pendingRaw: serializePendingLogin('oauth', NOW - 1000),
      storedSessionRaw: storedVictim,
      now: NOW,
    })).toBe(false);
  });

  it('ignores URLs without an access token, and unreadable stored sessions count as none', () => {
    expect(shouldAcceptUrlSession({}, { pendingRaw: serializePendingLogin('oauth', NOW), storedSessionRaw: null, now: NOW })).toBe(false);
    expect(shouldAcceptUrlSession({ access_token: at }, {
      pendingRaw: serializePendingLogin('oauth', NOW - 1000),
      storedSessionRaw: '{not json',
      now: NOW,
    })).toBe(true);
  });
});
