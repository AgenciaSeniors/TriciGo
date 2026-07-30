import { describe, it, expect } from 'vitest';
import { configFlag, resolveFxSyncFailure, resolveSoftLimitHours } from './fx-sync-outcome';

const base = { hasCurrentRate: true, rateAgeHours: 1.8, softLimitHours: 20 } as const;

describe('resolveFxSyncFailure', () => {
  it('downgrades a rate-limited run to 200 while the stored rate is still young', () => {
    // The production case on 2026-07-30: [429,429] from trmi, rate 1.8h old, recharges
    // unaffected. This must NOT wake anyone up.
    expect(resolveFxSyncFailure({ ...base, reason: 'all_methods_failed' }))
      .toEqual({ httpStatus: 200, degraded: true });
  });

  it('reports 502 once the stored rate reaches the soft limit', () => {
    expect(resolveFxSyncFailure({ ...base, reason: 'all_methods_failed', rateAgeHours: 20 }))
      .toEqual({ httpStatus: 502, degraded: false });
    expect(resolveFxSyncFailure({ ...base, reason: 'all_methods_failed', rateAgeHours: 23.9 }))
      .toEqual({ httpStatus: 502, degraded: false });
  });

  it('stays quiet immediately below the limit and goes loud exactly at it', () => {
    expect(resolveFxSyncFailure({ ...base, reason: 'all_methods_failed', rateAgeHours: 19.99 }).httpStatus).toBe(200);
    expect(resolveFxSyncFailure({ ...base, reason: 'all_methods_failed', rateAgeHours: 20.0 }).httpStatus).toBe(502);
  });

  it('is loud for our own config faults no matter how fresh the rate is', () => {
    // A missing token does not heal itself. Freshness must not buy it 20h of silence —
    // that is how the 2026-07-15 freeze stayed invisible for four days.
    expect(resolveFxSyncFailure({ ...base, reason: 'config_token_missing' }))
      .toEqual({ httpStatus: 502, degraded: false });
    expect(resolveFxSyncFailure({ ...base, reason: 'config_read_failed' }))
      .toEqual({ httpStatus: 502, degraded: false });
  });

  it('fails closed when there is no rate at all, or its age is unknowable', () => {
    expect(resolveFxSyncFailure({ ...base, reason: 'all_methods_failed', hasCurrentRate: false }).httpStatus).toBe(502);
    expect(resolveFxSyncFailure({ ...base, reason: 'all_methods_failed', rateAgeHours: null }).httpStatus).toBe(502);
    expect(resolveFxSyncFailure({ ...base, reason: 'all_methods_failed', rateAgeHours: NaN }).httpStatus).toBe(502);
    expect(resolveFxSyncFailure({ ...base, reason: 'all_methods_failed', rateAgeHours: Infinity }).httpStatus).toBe(502);
  });

  it('does not treat a future-dated rate as infinitely fresh', () => {
    // Clock skew or a backdated row must not create permanent silence.
    expect(resolveFxSyncFailure({ ...base, reason: 'all_methods_failed', rateAgeHours: -50 }).httpStatus).toBe(502);
  });
});

describe('resolveSoftLimitHours', () => {
  it('defaults to 20h when the key is absent or unusable', () => {
    expect(resolveSoftLimitHours(undefined, 24)).toBe(20);
    expect(resolveSoftLimitHours(null, 24)).toBe(20);
    expect(resolveSoftLimitHours('', 24)).toBe(20);
    expect(resolveSoftLimitHours('abc', 24)).toBe(20);
    expect(resolveSoftLimitHours(0, 24)).toBe(20);
    expect(resolveSoftLimitHours(-5, 24)).toBe(20);
  });

  it('accepts the jsonb shapes platform_config actually stores', () => {
    expect(resolveSoftLimitHours(6, 24)).toBe(6);      // jsonb number
    expect(resolveSoftLimitHours('6', 24)).toBe(6);    // jsonb string
    expect(resolveSoftLimitHours('"6"', 24)).toBe(6);  // quoted string
  });

  it('never lets the alarm be pushed past the money window', () => {
    // exchange_rate_max_age_hours is when recharges start failing closed. Warning after
    // that point would be worthless, so a typo cannot disable the warning.
    expect(resolveSoftLimitHours(2400, 24)).toBe(24);
    expect(resolveSoftLimitHours(30, 24)).toBe(24);
  });

  it('survives a nonsensical ceiling without going unbounded', () => {
    expect(resolveSoftLimitHours(20, NaN)).toBe(20);
    expect(resolveSoftLimitHours(20, 0)).toBe(20);
  });
});

describe('configFlag', () => {
  it('reads the jsonb BOOLEAN that production actually holds', () => {
    // The bug: exchange_rate_auto_update is jsonb boolean true in production, and the old
    // check was `cfg[key] === 'false'`. A boolean false can never equal the string
    // 'false', so the FX kill switch did not switch anything off.
    expect(configFlag(false, true)).toBe(false);
    expect(configFlag(true, true)).toBe(true);
    expect((false as unknown) === 'false').toBe(false); // pins why the old check failed
  });

  it('still reads the jsonb STRING that mig 00017 seeded', () => {
    expect(configFlag('false', true)).toBe(false);
    expect(configFlag('true', false)).toBe(true);
    expect(configFlag('"false"', true)).toBe(false);
    expect(configFlag(' FALSE ', true)).toBe(false);
  });

  it('falls back rather than guessing on anything else', () => {
    expect(configFlag(undefined, true)).toBe(true);
    expect(configFlag(null, true)).toBe(true);
    expect(configFlag('maybe', true)).toBe(true);
    expect(configFlag(undefined, false)).toBe(false);
  });
});
