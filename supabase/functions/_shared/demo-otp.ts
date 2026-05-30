// Decides whether an incoming OTP request is the Google Play review demo
// account, in which case send-sms-otp seeds a fixed code instead of sending a
// real SMS. Gated entirely by env: the bypass does not exist unless BOTH
// DEMO_PHONE and DEMO_OTP_CODE are configured, so production is inert by default.
export function resolveDemoOtp(
  phone: string,
  demoPhone: string | undefined,
  demoCode: string | undefined,
): string | null {
  if (!demoPhone || !demoCode) return null;
  // Only a properly-formed 6-digit code can activate the bypass, matching the
  // real OTP format — guards against a misconfigured/trivially-guessable code.
  if (!/^\d{6}$/.test(demoCode)) return null;
  if (phone !== demoPhone) return null;
  return demoCode;
}
