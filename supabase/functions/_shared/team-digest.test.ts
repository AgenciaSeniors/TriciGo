import { describe, expect, it } from 'vitest';
import {
  digestSecret,
  havanaYesterday,
  isValidDay,
  unsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from './team-digest.ts';

const USER = 'a1000000-0000-4000-8000-000000000001';

describe('team digest unsubscribe token', () => {
  it('is 64 hex characters and stable for the same secret and user', async () => {
    const a = await unsubscribeToken('secret-1', USER);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await unsubscribeToken('secret-1', USER)).toBe(a);
  });

  it('changes with the secret and with the user', async () => {
    const a = await unsubscribeToken('secret-1', USER);
    expect(await unsubscribeToken('secret-2', USER)).not.toBe(a);
    expect(await unsubscribeToken('secret-1', 'a1000000-0000-4000-8000-000000000002')).not.toBe(a);
  });

  it('verifies only the token made for that user with that secret', async () => {
    const t = await unsubscribeToken('secret-1', USER);
    expect(await verifyUnsubscribeToken('secret-1', USER, t)).toBe(true);
    expect(await verifyUnsubscribeToken('secret-2', USER, t)).toBe(false);
    expect(await verifyUnsubscribeToken('secret-1', 'a1000000-0000-4000-8000-000000000002', t)).toBe(false);
    expect(await verifyUnsubscribeToken('secret-1', USER, t.toUpperCase())).toBe(false);
    expect(await verifyUnsubscribeToken('secret-1', USER, 'abc')).toBe(false);
  });
});

describe('team digest helpers', () => {
  it('builds the link on the web origin, without a double slash', () => {
    expect(unsubscribeUrl('https://tricigo.com/', USER, 'f'.repeat(64)))
      .toBe(`https://tricigo.com/resumen-diario/baja#u=${USER}&t=${'f'.repeat(64)}`);
  });

  it('keeps the account and the token in the fragment, out of the query string', () => {
    // A query string reaches nginx logs and analytics; a fragment never leaves the browser.
    const url = new URL(unsubscribeUrl('https://tricigo.com', USER, 'f'.repeat(64)));
    expect(url.search).toBe('');
    expect(url.pathname).toBe('/resumen-diario/baja');
    const params = new URLSearchParams(url.hash.slice(1));
    expect(params.get('u')).toBe(USER);
    expect(params.get('t')).toBe('f'.repeat(64));
  });

  it('prefers TEAM_DIGEST_SECRET and falls back to the service key', () => {
    expect(digestSecret((k) => (k === 'TEAM_DIGEST_SECRET' ? 'own' : undefined), 'svc')).toBe('own');
    expect(digestSecret(() => undefined, 'svc')).toBe('svc');
    expect(digestSecret((k) => (k === 'TEAM_DIGEST_SECRET' ? '' : undefined), 'svc')).toBe('svc');
  });

  it('gives the Havana day before, in summer and winter time', () => {
    // 2026-10-08 03:30 UTC is still 2026-10-07 23:30 in Havana (UTC-4).
    expect(havanaYesterday(new Date('2026-10-08T03:30:00Z'))).toBe('2026-10-06');
    expect(havanaYesterday(new Date('2026-10-08T11:05:00Z'))).toBe('2026-10-07');
    // 2026-12-10 04:30 UTC is 2026-12-09 23:30 in Havana (UTC-5).
    expect(havanaYesterday(new Date('2026-12-10T04:30:00Z'))).toBe('2026-12-08');
    expect(havanaYesterday(new Date('2026-03-01T12:00:00Z'))).toBe('2026-02-28');
  });

  it('follows the Havana clock across both 2026 time changes and the new year', () => {
    // Spring forward: 2026-03-08 00:00 Havana (05:00 UTC) jumps to 01:00.
    expect(havanaYesterday(new Date('2026-03-08T04:59:00Z'))).toBe('2026-03-06');
    expect(havanaYesterday(new Date('2026-03-08T05:00:00Z'))).toBe('2026-03-07');
    // Fall back: 2026-11-01 01:00 Havana (UTC-4) goes back to 00:00 (UTC-5).
    expect(havanaYesterday(new Date('2026-11-01T03:59:00Z'))).toBe('2026-10-30');
    expect(havanaYesterday(new Date('2026-11-01T04:30:00Z'))).toBe('2026-10-31');
    expect(havanaYesterday(new Date('2026-11-02T04:30:00Z'))).toBe('2026-10-31');
    expect(havanaYesterday(new Date('2026-11-02T05:30:00Z'))).toBe('2026-11-01');
    // New year: 2027-01-01 04:30 UTC is still 2026-12-31 in Havana.
    expect(havanaYesterday(new Date('2027-01-01T04:30:00Z'))).toBe('2026-12-30');
    expect(havanaYesterday(new Date('2027-01-01T05:30:00Z'))).toBe('2026-12-31');
  });

  it('accepts only real YYYY-MM-DD days', () => {
    expect(isValidDay('2026-10-07')).toBe(true);
    expect(isValidDay('2026-02-30')).toBe(false);
    expect(isValidDay('2026-13-01')).toBe(false);
    expect(isValidDay('7/10/2026')).toBe(false);
    expect(isValidDay('')).toBe(false);
  });
});
