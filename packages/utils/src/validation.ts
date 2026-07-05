// ============================================================
// TriciGo — Validation Utilities
// ============================================================

/**
 * Validate a Cuban phone number.
 * Cuban mobile numbers are 8 digits starting with 5 or 6:
 *   - 5XXXXXXX  (legacy prefix, since 1993)
 *   - 6XXXXXXX  (new ETECSA prefixes 63/64, assigned to every new SIM since late 2023)
 * Full E.164 form: +53 5XXXXXXX / +53 6XXXXXXX. Landlines (7 / 2x-4x) are not mobiles.
 */
export function isValidCubanPhone(phone: string): boolean {
  if (!phone) return false;
  const cleaned = phone.replace(/[\s\-()]/g, '');
  // With country code: +53 5XXXXXXX / +53 6XXXXXXX
  if (/^\+53[56]\d{7}$/.test(cleaned)) return true;
  // Without country code: 5XXXXXXX / 6XXXXXXX
  if (/^[56]\d{7}$/.test(cleaned)) return true;
  return false;
}

/**
 * Normalize a phone number to E.164 format for Cuba.
 * "51234567" → "+5351234567", "63234567" → "+5363234567"
 */
export function normalizeCubanPhone(phone: string): string {
  const cleaned = phone.replace(/[\s\-()]/g, '');
  // Already in E.164 Cuba format
  if (cleaned.startsWith('+53') && cleaned.length === 11) return cleaned;
  // Country code without +
  if (cleaned.startsWith('53') && cleaned.length === 10) return `+${cleaned}`;
  // Local mobile number (8 digits starting with 5 or 6)
  if ((cleaned.startsWith('5') || cleaned.startsWith('6')) && cleaned.length === 8) return `+53${cleaned}`;
  // Short local number without country code — prepend +53
  if (!cleaned.startsWith('+') && cleaned.length <= 8) return `+53${cleaned}`;
  // Already has +, return as-is
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

/**
 * Validate an email address (basic).
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Validate a license plate number (Cuba format).
 * Common formats: P123456, T12345, etc.
 */
export function isValidPlateNumber(plate: string): boolean {
  const cleaned = plate.replace(/[\s\-]/g, '').toUpperCase();
  return /^[A-Z]\d{5,6}$/.test(cleaned);
}

/**
 * Validates a Cuban identity card number (Carnet de Identidad).
 * Format: 11 digits where first 6 are birth date (YYMMDD).
 */
export function isValidCubanId(id: string): boolean {
  if (!/^\d{11}$/.test(id)) return false;
  const month = parseInt(id.substring(2, 4), 10);
  const day = parseInt(id.substring(4, 6), 10);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * Validate latitude is within Cuba's range.
 */
export function isValidCubaLatitude(lat: number): boolean {
  return lat >= 19.5 && lat <= 23.5;
}

/**
 * Validate longitude is within Cuba's range.
 */
export function isValidCubaLongitude(lng: number): boolean {
  return lng >= -85.0 && lng <= -74.0;
}

/**
 * Validate coordinates are within Cuba's bounding box.
 */
export function isLocationInCuba(lat: number, lng: number): boolean {
  return isValidCubaLatitude(lat) && isValidCubaLongitude(lng);
}

/**
 * Validate OTP code (6 digits).
 */
export function isValidOTP(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/**
 * Mask a phone number for display, showing only country code + last 4 digits.
 * "+5355123456" → "+53 •••• 3456"
 * "55123456"    → "•••• 3456"
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const cleaned = phone.replace(/[\s\-()]/g, '');
  if (cleaned.length < 4) return '••••';
  const last4 = cleaned.slice(-4);
  if (cleaned.startsWith('+53')) return `+53 •••• ${last4}`;
  if (cleaned.startsWith('+')) {
    // Dynamically detect country code length (digits before subscriber number)
    const codeEnd = Math.max(2, cleaned.length - 7);
    return `${cleaned.slice(0, codeEnd)} •••• ${last4}`;
  }
  return `•••• ${last4}`;
}

/**
 * Sanitize user input text (trim, remove control characters).
 */
export function sanitizeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.trim().replace(/[\x00-\x1F\x7F]/g, '');
}

/**
 * Phone-OTP signups get a synthetic placeholder email
 * (`phone_<digits>@tricigo.app`) written to auth.users by the verify-otp Edge
 * Function. It is load-bearing for session minting (magic-link / password
 * grant) but is NOT a real address the user owns, so it must never be shown,
 * pre-filled into a form, or emailed. Detect it so the UI treats it as
 * "no email on file".
 *
 * NOTE: the same pattern is mirrored inline in Deno Edge Functions
 * (e.g. behavioral-emails) because they cannot import @tricigo/utils — keep
 * the regex in sync.
 */
const PLACEHOLDER_EMAIL_RE = /^phone_\d+@tricigo\.app$/i;

export function isPlaceholderEmail(email?: string | null): boolean {
  return !!email && PLACEHOLDER_EMAIL_RE.test(email.trim());
}

/**
 * Returns the email unless it is empty or the synthetic phone-OTP placeholder,
 * in which case it returns null (treat as "no real email on file").
 */
export function realEmail(email?: string | null): string | null {
  const e = email?.trim();
  if (!e || isPlaceholderEmail(e)) return null;
  return e;
}
