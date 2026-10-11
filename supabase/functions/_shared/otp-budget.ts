// ============================================================
// How many login codes a phone number can get, and fail, in a day.
//
// send-sms-otp already allows 6 codes per number every 10 minutes, and
// verify-otp and link-phone 10 checks each per number every 10 minutes, in
// separate buckets. Nothing capped the day: an attacker could make a number
// receive 864 SMS a day (our D7 bill, and the owner's phone buzzing all day),
// and check about 2,880 guesses a day against it (both endpoints use the same
// verify_cuba_otp, and a link-phone hit turns into a login through verify-otp's
// "recently verified" re-mint). At one million codes that is ~0.3 % a day of
// taking over the account behind the number, ~8 % a month.
//
// The day caps below sit well above what real users needed in 30 days of
// production (measured 2026-10-08 on rate_limits: at most 9 sends and 7
// link-phone checks per number in a day, verify-otp at most 6 outside the
// store-review demo phones):
//  - OTP_SEND_DAILY_MAX codes sent per number (send-sms-otp; the demo phones,
//    which get a fixed code and no SMS, keep their exemption).
//  - OTP_FAIL_DAILY_MAX failed checks per number, shared by verify-otp and
//    link-phone. A token is taken before the check and given back when the code
//    is right, so only wrong, expired or exhausted codes count. That also bounds
//    guesses against the demo phones' fixed code, which never rotates.
//
// Someone who burns a number's budget locks its owner out of OTP until the
// window rolls (fixed UTC days, like every check_rate_limit window). That was
// already possible by keeping the 10-minute buckets full; it is the price of a
// guess budget of 20 a day instead of thousands.
//
// Pure module with no remote imports, so packages/api's vitest runs its test.
// ============================================================

export const OTP_DAY_MS = 24 * 60 * 60 * 1000;
export const OTP_SEND_DAILY_MAX = 15;
export const OTP_FAIL_DAILY_MAX = 20;

// Not under send-sms-otp: or verify-otp:. The SMS watchdog (00556) and
// supabase/sms-delivery-health-check.sql read send-sms-otp:phone:% as one row
// per real send and the rest of send-sms-otp:% as per-IP buckets.
export const otpSendDayKey = (phone: string) => `otp-send-day:${phone}`;
export const otpFailDayKey = (phone: string) => `otp-fail-day:${phone}`;

/**
 * A six-digit login code. `byte % 10` over 0-255 makes 0-5 more likely than
 * 6-9 (26 vs 25 bytes each), which makes "000000" about 10 % likelier than a
 * fair code; bytes 250-255 are dropped instead.
 */
export function generateOtpCode(
  fill: (buf: Uint8Array) => Uint8Array = (buf) => crypto.getRandomValues(buf),
): string {
  let code = '';
  while (code.length < 6) {
    for (const byte of fill(new Uint8Array(16))) {
      if (byte >= 250) continue;
      code += String(byte % 10);
      if (code.length === 6) break;
    }
  }
  return code;
}
