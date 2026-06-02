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
  // DEMO_PHONE may be a single E.164 number or a comma/space-separated list,
  // so each app (rider + driver) can have its own demo number mapped to its
  // own demo user. The bypass only matches a number listed exactly.
  const allowed = demoPhone.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
  if (!allowed.includes(phone)) return null;
  return demoCode;
}
