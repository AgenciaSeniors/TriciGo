// ============================================================
// TriciGo — Validation Utilities
// ============================================================

/**
 * Validate a Cuban phone number.
 * Cuban mobile numbers: +53 5XXXXXXX (8 digits starting with 5)
 */
export function isValidCubanPhone(phone: string): boolean {
  const cleaned = phone.replace(/[\s\-()]/g, '');
  // With country code: +535XXXXXXX
  if (/^\+535\d{7}$/.test(cleaned)) return true;
  // Without country code: 5XXXXXXX
  if (/^5\d{7}$/.test(cleaned)) return true;
  return false;
}

/**
 * Normalize a phone number to E.164 format for Cuba.
 * "51234567" → "+5351234567"
 */
export function normalizeCubanPhone(phone: string): string {
  const cleaned = phone.replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('+53')) return cleaned;
  if (cleaned.startsWith('53') && cleaned.length === 10) return `+${cleaned}`;
  return `+53${cleaned}`;
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
  if (cleaned.startsWith('+')) return `${cleaned.slice(0, 3)} •••• ${last4}`;
  return `•••• ${last4}`;
}

/**
 * Sanitize user input text (trim, remove control characters).
 */
export function sanitizeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.trim().replace(/[\x00-\x1F\x7F]/g, '');
}
