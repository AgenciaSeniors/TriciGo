// Support WhatsApp numbers. Two sources, combined by orderSupportPhones:
// - the list a super_admin sets in platform_config (support_whatsapp_phones, 00682), so the
//   numbers change without a new build. It is ordered and never empty: every screen falls back
//   to SUPPORT_WHATSAPP_PHONES when the key is missing, empty or holds something that is not a
//   phone;
// - the operator on shift the server names (get_support_contact and request_ride_help, 00683),
//   cached on the device so it shows at once and offline (resolveSupportPhone).
// Pure TypeScript: no React Native or browser APIs; the cache store is passed in.

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

// ── The operator on shift, from the server (00683) ──────────────────────────────────────────

/**
 * What the server's contact column holds (its CHECK, 00683): + and 8 to 15 digits. Only checks a
 * cached value; a number someone types goes through parseSupportPhone, the one normalizer.
 */
const E164 = /^\+[1-9][0-9]{7,14}$/;

export type SupportContactResult =
  | { status: 'ok'; phone: string | null }
  | { status: 'unreachable' };

export interface SupportPhoneStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const SUPPORT_PHONE_CACHE_KEY = 'tricigo.support_phone';

/**
 * The last support number received, read from the cache only: the help screens show it at once,
 * then let the server's answer (resolveSupportPhone) replace it. Null when nothing is cached or
 * the cached value is not E.164. Never writes; a failing store never makes this throw.
 */
export async function readCachedSupportPhone(store: SupportPhoneStore): Promise<string | null> {
  try {
    const value = await store.getItem(SUPPORT_PHONE_CACHE_KEY);
    return value !== null && E164.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The support phone to offer: the server's answer when reachable (cached, or the cache
 * cleared when there is none), the last cached number when offline, otherwise null.
 * A failing store never makes this throw.
 */
export async function resolveSupportPhone(
  fetchContact: () => Promise<SupportContactResult>,
  store: SupportPhoneStore,
): Promise<string | null> {
  let result: SupportContactResult;
  try {
    result = await fetchContact();
  } catch {
    result = { status: 'unreachable' };
  }

  if (result.status === 'unreachable') return readCachedSupportPhone(store);

  try {
    if (result.phone) await store.setItem(SUPPORT_PHONE_CACHE_KEY, result.phone);
    else await store.removeItem(SUPPORT_PHONE_CACHE_KEY);
  } catch {
    // A failed cache write must not hide the answer.
  }
  return result.phone;
}

// ── Both sources together ───────────────────────────────────────────────────────────────────

/**
 * The numbers a help screen lists, in order: the operator the server named (`contact`, from
 * get_support_contact or its cache) first, then the configured list (useSupportPhones) without
 * the numbers already listed. Numbers are compared by their digits (parseSupportPhone) and come
 * out as +<digits>; one WhatsApp could not open is left out. Never empty: with nothing usable it
 * is the built-in list. The one-tap buttons of those screens open its first number.
 */
export function orderSupportPhones(
  contact: string | null | undefined,
  list: readonly string[],
): string[] {
  const ordered: string[] = [];
  for (const raw of [contact, ...list]) {
    const phone = parseSupportPhone(raw);
    if (phone && !ordered.includes(phone)) ordered.push(phone);
  }
  return ordered.length > 0 ? ordered : [...SUPPORT_WHATSAPP_PHONES];
}

/**
 * The number "Pide ayuda" opens: the ride's owner the server answered with (request_ride_help),
 * else the operator on shift the screen already knows (`contact`), else the first configured
 * number. Always one WhatsApp can open.
 */
export function supportHelpPhone(
  helpPhone: string | null | undefined,
  contact: string | null | undefined,
  list: readonly string[],
): string {
  return primarySupportPhone(orderSupportPhones(parseSupportPhone(helpPhone) ?? contact, list));
}
