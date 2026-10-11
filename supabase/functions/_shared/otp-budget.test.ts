import { describe, expect, it } from 'vitest';
import {
  OTP_FAIL_DAILY_MAX,
  OTP_SEND_DAILY_MAX,
  OTP_DAY_MS,
  generateOtpCode,
  otpFailDayKey,
  otpSendDayKey,
} from './otp-budget';

/** A random source that hands out `bytes` in order, then zeros. */
function scripted(bytes: number[]) {
  let i = 0;
  return (buf: Uint8Array) => {
    for (let j = 0; j < buf.length; j++) buf[j] = i < bytes.length ? bytes[i++] : 0;
    return buf;
  };
}

describe('generateOtpCode', () => {
  it('returns six digits', () => {
    for (let n = 0; n < 200; n++) expect(generateOtpCode()).toMatch(/^\d{6}$/);
  });

  it('skips bytes from 250 to 255, which would make 0-5 more likely than 6-9', () => {
    expect(generateOtpCode(scripted([255, 250, 7, 251, 13, 249, 0, 120, 99]))).toBe('739009');
  });

  it('keeps drawing until it has six digits', () => {
    expect(generateOtpCode(scripted([...Array(40).fill(255), 1, 2, 3, 4, 5, 6]))).toBe('123456');
  });

  it('gives every digit the same weight over the bytes it accepts', () => {
    const counts = Array(10).fill(0);
    for (let b = 0; b < 256; b++) {
      const code = generateOtpCode(scripted([b, b, b, b, b, b, 0, 0, 0, 0, 0, 0]));
      if (b < 250) counts[Number(code[0])]++;
    }
    expect(counts).toEqual(Array(10).fill(25));
  });
});

describe('daily budgets', () => {
  it('sit above what real users needed in 30 days of production', () => {
    // Measured 2026-10-08 on rate_limits: at most 9 sends and 7 link-phone checks
    // per number in a day; verify-otp at most 6 outside the store-review demo phones.
    expect(OTP_SEND_DAILY_MAX).toBeGreaterThanOrEqual(15);
    expect(OTP_FAIL_DAILY_MAX).toBeGreaterThanOrEqual(20);
    expect(OTP_DAY_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('use keys the SMS watchdog does not read', () => {
    // 00556 and sms-delivery-health-check.sql read send-sms-otp:phone:% as "one
    // per real send" and send-sms-otp:% minus that as per-IP buckets.
    for (const key of [otpSendDayKey('+5355512345'), otpFailDayKey('+5355512345')]) {
      expect(key.startsWith('send-sms-otp:')).toBe(false);
      expect(key.startsWith('verify-otp:')).toBe(false);
      expect(key.endsWith('+5355512345')).toBe(true);
    }
    expect(otpSendDayKey('+5355512345')).not.toBe(otpFailDayKey('+5355512345'));
  });
});
