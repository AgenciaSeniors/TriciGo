import { describe, it, expect, beforeEach } from 'vitest';
import {
  adjustAuthResponse,
  anchorSessionExpiry,
  isAuthTokenUrl,
  isRefreshTokenUrl,
  RefreshRateLimitedError,
} from '../clockSafeAuth';
import { noteServerDate, resetServerClock, serverClockOffsetMs, serverNowMs } from '../serverClock';

const BASE = 'https://example.supabase.co';
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });

describe('token URLs', () => {
  it('recognizes the token endpoint and the refresh grant', () => {
    expect(isAuthTokenUrl(`${BASE}/auth/v1/token?grant_type=refresh_token`)).toBe(true);
    expect(isRefreshTokenUrl(`${BASE}/auth/v1/token?grant_type=refresh_token`)).toBe(true);
    expect(isRefreshTokenUrl(`${BASE}/auth/v1/token?foo=1&grant_type=refresh_token`)).toBe(true);
    expect(isRefreshTokenUrl(`${BASE}/auth/v1/token?grant_type=password`)).toBe(false);
    expect(isRefreshTokenUrl(`${BASE}/auth/v1/token?grant_type=refresh_token_x`)).toBe(false);
    expect(isAuthTokenUrl(`${BASE}/rest/v1/rides?select=id`)).toBe(false);
    expect(isAuthTokenUrl(`${BASE}/auth/v1/user`)).toBe(false);
  });
});

describe('anchorSessionExpiry', () => {
  const now = 1_793_000_000_000;

  it('measures expires_at on the device clock', async () => {
    const res = json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, expires_at: 42, token_type: 'bearer' });
    const out = await anchorSessionExpiry(res, now);
    const body = await out.json();
    expect(body.expires_at).toBe(Math.round(now / 1000) + 3600);
    expect(body).toMatchObject({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'bearer' });
    expect(out.status).toBe(200);
    expect(out.headers.get('content-type')).toContain('json');
  });

  it('leaves errors, non-sessions and bodies without expires_in alone', async () => {
    for (const res of [
      json({ error: 'invalid_grant' }, 400),
      json({ msg: 'no expiry' }),
      json([1, 2, 3]),
      json({ expires_in: 'soon' }),
      json({ expires_in: 0 }),
      new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    ]) {
      const out = await anchorSessionExpiry(res, now);
      expect(out).toBe(res);
    }
  });

  it('returns the same response when expires_at already matches', async () => {
    const res = json({ expires_in: 3600, expires_at: Math.round(now / 1000) + 3600 });
    expect(await anchorSessionExpiry(res, now)).toBe(res);
  });
});

describe('adjustAuthResponse', () => {
  it('throws on a 429 for a refresh, so auth-js keeps the session', async () => {
    const res = json({ error_code: 'over_request_rate_limit' }, 429);
    await expect(adjustAuthResponse(`${BASE}/auth/v1/token?grant_type=refresh_token`, res)).rejects.toBeInstanceOf(
      RefreshRateLimitedError,
    );
  });

  it('returns a 429 on a sign-in as is: the user must see "too many attempts"', async () => {
    const res = json({ error_code: 'over_request_rate_limit' }, 429);
    expect(await adjustAuthResponse(`${BASE}/auth/v1/token?grant_type=password`, res)).toBe(res);
  });

  it('does not touch other endpoints', async () => {
    const res = json({ expires_in: 3600, expires_at: 1 });
    expect(await adjustAuthResponse(`${BASE}/rest/v1/sessions`, res)).toBe(res);
    const limited = json({}, 429);
    expect(await adjustAuthResponse(`${BASE}/rest/v1/rides`, limited)).toBe(limited);
  });
});

describe('serverClock', () => {
  beforeEach(() => resetServerClock());

  it('ignores offsets under 30 s and a missing or bad header', () => {
    const at = Date.parse('2026-11-01T12:00:10.000Z');
    noteServerDate('Sun, 01 Nov 2026 12:00:00 GMT', at); // device 9.5 s ahead
    expect(serverClockOffsetMs()).toBe(0);
    noteServerDate(null, at);
    noteServerDate('garbage', at);
    expect(serverClockOffsetMs()).toBe(0);
  });

  it('corrects a phone an hour ahead, and forgets it once the clock is fixed', () => {
    const at = Date.parse('2026-11-01T13:00:00.000Z');
    noteServerDate('Sun, 01 Nov 2026 12:00:00 GMT', at);
    expect(serverClockOffsetMs()).toBe(-3_600_000 + 500);
    expect(Math.abs(serverNowMs() - (Date.now() - 3_600_000))).toBeLessThan(1_000);

    noteServerDate('Sun, 01 Nov 2026 13:00:00 GMT', at);
    expect(serverClockOffsetMs()).toBe(0);
  });

  it('corrects a phone that is behind', () => {
    const at = Date.parse('2026-11-01T11:00:00.000Z');
    noteServerDate('Sun, 01 Nov 2026 12:00:00 GMT', at);
    expect(serverClockOffsetMs()).toBe(3_600_000 + 500);
  });
});
