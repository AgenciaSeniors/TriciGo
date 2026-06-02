import { describe, it, expect } from 'vitest';
import { resolveDemoOtp } from './demo-otp';

describe('resolveDemoOtp', () => {
  it('returns the fixed demo code when the phone matches DEMO_PHONE and both are configured', () => {
    expect(resolveDemoOtp('+5355555555', '+5355555555', '246810')).toBe('246810');
  });

  it('supports a comma/space-separated DEMO_PHONE list (one demo number per app)', () => {
    const list = '+5355550100, +5355550101';
    expect(resolveDemoOtp('+5355550100', list, '000000')).toBe('000000');
    expect(resolveDemoOtp('+5355550101', list, '000000')).toBe('000000');
    expect(resolveDemoOtp('+5355559999', list, '000000')).toBeNull();
  });

  it('returns null when the phone does not match DEMO_PHONE', () => {
    expect(resolveDemoOtp('+5351234567', '+5355555555', '246810')).toBeNull();
  });

  it('is disabled by default: returns null when DEMO_PHONE is unset or empty', () => {
    expect(resolveDemoOtp('+5355555555', undefined, '246810')).toBeNull();
    expect(resolveDemoOtp('+5355555555', '', '246810')).toBeNull();
  });

  it('returns null when DEMO_OTP_CODE is unset or empty (never activate with a blank code)', () => {
    expect(resolveDemoOtp('+5355555555', '+5355555555', undefined)).toBeNull();
    expect(resolveDemoOtp('+5355555555', '+5355555555', '')).toBeNull();
  });

  it('returns null when DEMO_OTP_CODE is not a 6-digit numeric code (guards misconfiguration)', () => {
    expect(resolveDemoOtp('+5355555555', '+5355555555', '1')).toBeNull();
    expect(resolveDemoOtp('+5355555555', '+5355555555', 'abcdef')).toBeNull();
    expect(resolveDemoOtp('+5355555555', '+5355555555', '1234567')).toBeNull();
  });
});
