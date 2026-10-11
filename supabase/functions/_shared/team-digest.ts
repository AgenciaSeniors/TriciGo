// ============================================================
// Team daily digest (00656) — pure helpers shared by send-team-digest and
// team-digest-unsubscribe: the signed unsubscribe link, the Havana day the digest covers,
// and input checks. No remote imports and no Deno, so packages/api's vitest runs them.
// ============================================================

/** The page on the web app behind "Dejar de recibir este resumen" (Edge Functions cannot serve HTML). */
export const UNSUBSCRIBE_PATH = '/resumen-diario/baja';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();

/** HMAC-SHA256 of `team-digest:<user id>`, hex. Only whoever holds the secret can make one. */
export async function unsubscribeToken(secret: string, userId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`team-digest:${userId}`)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison against the token for that user. */
export async function verifyUnsubscribeToken(secret: string, userId: string, token: string): Promise<boolean> {
  if (!TOKEN_RE.test(token)) return false;
  const expected = await unsubscribeToken(secret, userId);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export function unsubscribeUrl(webOrigin: string, userId: string, token: string): string {
  return `${webOrigin.replace(/\/+$/, '')}${UNSUBSCRIBE_PATH}?u=${encodeURIComponent(userId)}&t=${token}`;
}

/**
 * TEAM_DIGEST_SECRET when set, else the service key. With the fallback, rotating the service key
 * invalidates the links in e-mails already sent; the next day's e-mail carries working ones.
 */
export function digestSecret(env: (name: string) => string | undefined, serviceKey: string): string {
  return env('TEAM_DIGEST_SECRET') || serviceKey;
}

/** The Havana calendar day before `now`, as YYYY-MM-DD. */
export function havanaYesterday(now: Date): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Havana',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
}

/** A real calendar day written as YYYY-MM-DD. */
export function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}
