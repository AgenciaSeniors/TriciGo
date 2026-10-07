import { describe, expect, it } from 'vitest';
import { isAccountBanned, isReservedLoginEmail, phoneConflictsWithAccount, syntheticLoginEmail } from './login-identity';

describe('syntheticLoginEmail', () => {
  it('builds the address verify-otp gives a phone account', () => {
    expect(syntheticLoginEmail('+5351234567')).toBe('phone_5351234567@tricigo.app');
    expect(syntheticLoginEmail('5351234567')).toBe('phone_5351234567@tricigo.app');
  });
});

describe('isReservedLoginEmail', () => {
  it.each([
    'phone_5351234567@tricigo.app',
    'PHONE_5351234567@TRICIGO.APP',
    '  phone_5351234567@tricigo.app  ',
    'anything@tricigo.app',
    'x@mail.tricigo.app',
  ])('refuses %s', (email) => {
    expect(isReservedLoginEmail(email)).toBe(true);
  });

  it.each([
    'eduardo@gmail.com',
    'soporte@tricigo.com',
    'phone_5351234567@tricigo.app.evil.com',
    'phone_5351234567@nottricigo.app',
    '',
  ])('accepts %s', (email) => {
    expect(isReservedLoginEmail(email)).toBe(false);
  });
});

describe('phoneConflictsWithAccount', () => {
  const CONFIRMED = '2026-10-06T10:00:00Z';

  it('is true when the account has no phone (only a squattable email could match it)', () => {
    expect(phoneConflictsWithAccount(null, '+5351234567', CONFIRMED)).toBe(true);
    expect(phoneConflictsWithAccount(undefined, '+5351234567', CONFIRMED)).toBe(true);
    expect(phoneConflictsWithAccount('', '+5351234567', CONFIRMED)).toBe(true);
  });

  it('is false when the account holds the login phone, confirmed, in any format', () => {
    // GoTrue stores E.164 digits without '+'; verify-otp works with '+'.
    expect(phoneConflictsWithAccount('5351234567', '+5351234567', CONFIRMED)).toBe(false);
    expect(phoneConflictsWithAccount('+5351234567', '+5351234567', CONFIRMED)).toBe(false);
  });

  it('is true when the account holds the phone but never confirmed it', () => {
    // GoTrue's public phone signup leaves exactly this behind.
    expect(phoneConflictsWithAccount('5351234567', '+5351234567', null)).toBe(true);
    expect(phoneConflictsWithAccount('5351234567', '+5351234567')).toBe(true);
  });

  it('is true when the account belongs to a different phone', () => {
    expect(phoneConflictsWithAccount('5359999999', '+5351234567', CONFIRMED)).toBe(true);
    expect(phoneConflictsWithAccount('5511987654321', '+5351234567', CONFIRMED)).toBe(true);
  });
});

describe('isAccountBanned', () => {
  const now = new Date('2026-10-07T12:00:00Z');

  it('is true for a ban that has not ended (admin_set_user_active, 00629)', () => {
    expect(isAccountBanned('2126-10-07T12:00:00Z', now)).toBe(true);
    expect(isAccountBanned('2026-10-07T12:00:01Z', now)).toBe(true);
  });

  it('is false with no ban or one that already ended', () => {
    expect(isAccountBanned(null, now)).toBe(false);
    expect(isAccountBanned(undefined, now)).toBe(false);
    expect(isAccountBanned('', now)).toBe(false);
    expect(isAccountBanned('2026-10-07T12:00:00Z', now)).toBe(false);
    expect(isAccountBanned('2020-01-01T00:00:00Z', now)).toBe(false);
  });

  it('treats a value it cannot read as no ban (GoTrue refuses the login anyway)', () => {
    expect(isAccountBanned('not a date', now)).toBe(false);
  });
});
