// The support WhatsApp numbers, set by a super_admin in platform_config
// (support_whatsapp_phones, 00682) so they change without a new build. The
// list is ordered: the one-tap buttons open the first number and the help
// screens show them all. Every screen falls back to SUPPORT_WHATSAPP_PHONES
// when the key is missing, empty or holds something that is not a phone.

/** The platform_config key the admin edits. */
export const SUPPORT_PHONES_CONFIG_KEY = 'support_whatsapp_phones';

/** The built-in support numbers, in order, used until the key can be read. Never empty. */
export const SUPPORT_WHATSAPP_PHONES: readonly [string, ...string[]] = ['+5355159376', '+5354269290'];

/** E.164 allows at most 15 digits. */
const MAX_DIGITS = 15;

/** What an admin may put between two numbers. Spaces are not one: they sit inside a number. */
const SEPARATORS = /[,;/|\r\n]+/;

/**
 * One number as +<digits>, or null when WhatsApp could not open it. Accepts what
 * an admin types (spaces, dashes, parentheses) and an 8-digit Cuban mobile
 * (starts with 5 or 6), which gets +53. A JSON number is read too.
 */
export function parseSupportPhone(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 8 && /^[56]/.test(digits)) digits = `53${digits}`;
  if (digits.length < 10 || digits.length > MAX_DIGITS) return null;
  return `+${digits}`;
}

/**
 * The ordered list of numbers in a config value: text with numbers separated by
 * commas (or ; / | new line), a JSON array, or a single number. A repeated number
 * keeps its first place. Null when any part is not a phone or there is none, so
 * the panel can refuse the value and the apps fall back as a whole.
 */
export function parseSupportPhones(raw: unknown): string[] | null {
  const parts: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(SEPARATORS)
      : typeof raw === 'number'
        ? [raw]
        : [];
  const phones: string[] = [];
  for (const part of parts) {
    if (typeof part === 'string' && part.trim() === '') continue;
    const phone = parseSupportPhone(part);
    if (!phone) return null;
    if (!phones.includes(phone)) phones.push(phone);
  }
  return phones.length > 0 ? phones : null;
}

/** The numbers the apps use: the configured list, or the built-in one. */
export function resolveSupportPhones(raw: unknown): string[] {
  return parseSupportPhones(raw) ?? [...SUPPORT_WHATSAPP_PHONES];
}

/**
 * The number a one-tap button opens ("Pedir ayuda", WhatsApp in Soporte, the
 * driver's support button): the first of the list. The one place to change
 * if support ever splits riders between its numbers.
 */
export function primarySupportPhone(phones: readonly string[]): string {
  return phones[0] ?? SUPPORT_WHATSAPP_PHONES[0];
}

/** "+53 5515 9376" for a Cuban mobile; any other number as +<digits>. */
export function formatSupportPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('53')) {
    return `+53 ${digits.slice(2, 6)} ${digits.slice(6)}`;
  }
  return `+${digits}`;
}

/** wa.me link to a support chat, with the text typed in when there is one. */
export function supportWhatsAppUrl(phone: string, text?: string): string {
  const url = `https://wa.me/${phone.replace(/\D/g, '')}`;
  return text ? `${url}?text=${encodeURIComponent(text)}` : url;
}
