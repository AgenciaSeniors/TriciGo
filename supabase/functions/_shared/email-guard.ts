// ============================================================
// Synthetic phone-OTP placeholder email guard (shared, Deno)
// ============================================================
// Mirror of isPlaceholderEmail()/realEmail() in
// packages/utils/src/validation.ts — Deno Edge Functions can't import
// from @tricigo/utils (Node/TS package), so this is the single source
// for the Edge runtime. KEEP THE REGEX IN SYNC with validation.ts.
//
// Phone-OTP accounts get a synthetic `phone_<digits>@tricigo.app` email
// in auth.users.email (minted by verify-otp — it is load-bearing for
// login and must NEVER be removed from auth.users). That address is not
// real and must never be emailed (it bounces), printed in a document, or
// sent to an external payment processor as if it were the user's email.
// ============================================================

const PLACEHOLDER_EMAIL_RE = /^phone_\d+@tricigo\.app$/i;

/** True when `email` is the synthetic phone-OTP placeholder. */
export function isPlaceholderEmail(email?: string | null): boolean {
  return !!email && PLACEHOLDER_EMAIL_RE.test(email.trim());
}

/**
 * Returns the email unless it is empty or the synthetic placeholder, in
 * which case it returns null ("no real email on file").
 */
export function realEmail(email?: string | null): string | null {
  const e = email?.trim();
  if (!e || isPlaceholderEmail(e)) return null;
  return e;
}
