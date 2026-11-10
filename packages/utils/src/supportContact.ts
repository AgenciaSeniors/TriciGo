// Support WhatsApp number: normalization and offline-safe resolution (spec 2026-11-07).
// Pure TypeScript: no React Native or browser APIs; the cache store is passed in.

const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * Normalizes a typed WhatsApp number to E.164, or null when it is not valid.
 * Strips spaces, dashes, dots and parentheses; keeps a leading "+"; an 8-digit
 * Cuban mobile (starts with 5) typed without prefix gets "+53".
 */
export function normalizeSupportWhatsapp(raw: string): string | null {
  const compact = raw.replace(/[\s\-.()]/g, '');
  if (compact === '') return null;
  const candidate = /^[5][0-9]{7}$/.test(compact) ? `+53${compact}` : compact;
  return E164.test(candidate) ? candidate : null;
}

export type SupportContactResult =
  | { status: 'ok'; phone: string | null }
  | { status: 'unreachable' };

export interface SupportPhoneStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const SUPPORT_PHONE_CACHE_KEY = 'tricigo.support_phone';

async function readCached(store: SupportPhoneStore): Promise<string | null> {
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

  if (result.status === 'unreachable') return readCached(store);

  try {
    if (result.phone) await store.setItem(SUPPORT_PHONE_CACHE_KEY, result.phone);
    else await store.removeItem(SUPPORT_PHONE_CACHE_KEY);
  } catch {
    // A failed cache write must not hide the answer.
  }
  return result.phone;
}
