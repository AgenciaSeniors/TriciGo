// ============================================================
// TriciGo — who may sign the app in through a link
//
// Google, Apple and the email sign-in link come back to the apps as
// `<scheme>://auth/callback#access_token=…&refresh_token=…` (and to the web as
// `…#access_token=…`). Those links are not secret: anyone can sign up, take the
// tokens of their OWN account and send the link to someone else. Until this
// module the apps and the web took any such link and replaced the session with
// it, even with another account already signed in. The victim then kept using
// the app inside the attacker's account: trips with their pickup and drop-off,
// saved places, trusted contacts and card recharges all landed there.
//
// The rule:
//   - a link never replaces the session of another account;
//   - it is taken without asking only when this device started a login a few
//     minutes ago (the pending-login marker) and, for an email link, it opens
//     the account whose email was typed;
//   - anything else asks first, showing the account the link opens (native) or
//     is refused (web, where the check has to be synchronous).
//
// Pure functions only: the apps keep the marker in AsyncStorage and the web in
// localStorage, both under PENDING_LOGIN_STORAGE_KEY.
// ============================================================

import { realEmail } from './validation';

export interface AuthCallbackTokens {
  accessToken: string;
  refreshToken: string;
}

/** Claims read from an access token WITHOUT checking its signature: only used
 *  to decide and to show the account; the session itself is still validated by
 *  Supabase when it is set. */
export interface AuthTokenClaims {
  sub: string;
  email: string | null;
  phone: string | null;
  /** Seconds since the epoch. */
  exp: number | null;
}

export type PendingLoginKind = 'oauth' | 'email_link';

export interface PendingLogin {
  kind: PendingLoginKind;
  /** Milliseconds since the epoch. */
  startedAt: number;
  /** Lowercased email the user typed for an email link; null otherwise. */
  expectedEmail: string | null;
}

export const PENDING_LOGIN_STORAGE_KEY = 'tricigo_pending_login';

/** How long after starting a login its link is taken without asking: the
 *  Google/Apple round trip takes seconds, an email link lives one hour. */
export const PENDING_LOGIN_TTL_MS: Record<PendingLoginKind, number> = {
  oauth: 10 * 60_000,
  email_link: 60 * 60_000,
};

/** A marker dated this far in the future still counts (clock adjustments). */
const CLOCK_SKEW_MS = 60_000;

export type AuthCallbackDecision =
  | { action: 'accept' }
  | { action: 'confirm'; accountLabel: string | null }
  | { action: 'ignore'; reason: 'invalid_token' | 'already_signed_in' | 'other_account_signed_in' };

/**
 * Tokens of an exact `<scheme>://auth/callback` link (optional query, tokens in
 * the fragment), or null. A URL that merely contains "auth/callback" somewhere
 * is not a sign-in link.
 */
export function parseAuthCallbackUrl(url: string, schemes: readonly string[]): AuthCallbackTokens | null {
  const hashIdx = url.indexOf('#');
  if (hashIdx < 0) return null;
  const head = url.slice(0, hashIdx);
  const queryIdx = head.indexOf('?');
  const base = (queryIdx < 0 ? head : head.slice(0, queryIdx)).toLowerCase();
  if (!schemes.some((s) => base === `${s.toLowerCase()}://auth/callback`)) return null;

  const params = new URLSearchParams(url.slice(hashIdx + 1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64UrlToUtf8(segment: string): string | null {
  const s = segment.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*$/.test(s)) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    buffer = (buffer << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  try {
    // Percent-encode the bytes and let decodeURIComponent do the UTF-8: no
    // dependency on atob/TextDecoder, which Hermes builds don't all have.
    return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''));
  } catch {
    return null;
  }
}

export function decodeAuthTokenClaims(accessToken: string): AuthTokenClaims | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  const json = base64UrlToUtf8(parts[1]);
  if (json === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.sub !== 'string' || p.sub === '') return null;
  return {
    sub: p.sub,
    email: typeof p.email === 'string' && p.email !== '' ? p.email : null,
    phone: typeof p.phone === 'string' && p.phone !== '' ? p.phone : null,
    exp: typeof p.exp === 'number' ? p.exp : null,
  };
}

/** What to show for the account a link opens: its real email, or its phone. */
export function authAccountLabel(claims: AuthTokenClaims): string | null {
  const email = realEmail(claims.email);
  if (email) return email;
  const digits = claims.phone?.replace(/\D/g, '') || claims.email?.match(/^phone_(\d+)@/i)?.[1] || '';
  return digits ? `+${digits}` : null;
}

export function serializePendingLogin(kind: PendingLoginKind, now: number, expectedEmail?: string | null): string {
  const email = expectedEmail?.trim().toLowerCase() || null;
  return JSON.stringify({ kind, startedAt: now, expectedEmail: email });
}

export function parsePendingLogin(raw: string | null | undefined): PendingLogin | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.kind !== 'oauth' && o.kind !== 'email_link') return null;
  if (typeof o.startedAt !== 'number' || !Number.isFinite(o.startedAt)) return null;
  return {
    kind: o.kind,
    startedAt: o.startedAt,
    expectedEmail: typeof o.expectedEmail === 'string' && o.expectedEmail !== '' ? o.expectedEmail.toLowerCase() : null,
  };
}

function pendingStillValid(pending: PendingLogin | null, now: number): pending is PendingLogin {
  if (!pending) return false;
  const age = now - pending.startedAt;
  return age >= -CLOCK_SKEW_MS && age <= PENDING_LOGIN_TTL_MS[pending.kind];
}

export function decideAuthCallback(input: {
  claims: AuthTokenClaims | null;
  currentUserId: string | null;
  pending: PendingLogin | null;
  now: number;
}): AuthCallbackDecision {
  const { claims, currentUserId, pending, now } = input;
  if (!claims || (claims.exp !== null && claims.exp * 1000 <= now)) {
    return { action: 'ignore', reason: 'invalid_token' };
  }
  if (currentUserId) {
    return currentUserId === claims.sub
      ? { action: 'ignore', reason: 'already_signed_in' }
      : { action: 'ignore', reason: 'other_account_signed_in' };
  }
  if (pendingStillValid(pending, now)) {
    const emailMatches =
      pending.kind !== 'email_link' ||
      !pending.expectedEmail ||
      claims.email?.trim().toLowerCase() === pending.expectedEmail;
    if (emailMatches) return { action: 'accept' };
  }
  return { action: 'confirm', accountLabel: authAccountLabel(claims) };
}

function storedSessionUserId(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { user?: { id?: unknown } } | null;
    return typeof v?.user?.id === 'string' ? v.user.id : null;
  } catch {
    return null;
  }
}

/**
 * Web: whether supabase-js may take the session in the URL (its
 * `detectSessionInUrl` callback, which must answer synchronously). Only an
 * outright accept passes; a link that would need confirming is refused.
 */
export function shouldAcceptUrlSession(
  params: Record<string, string | undefined>,
  ctx: { pendingRaw: string | null; storedSessionRaw: string | null; now: number },
): boolean {
  const accessToken = params.access_token;
  if (!accessToken) return false;
  const decision = decideAuthCallback({
    claims: decodeAuthTokenClaims(accessToken),
    currentUserId: storedSessionUserId(ctx.storedSessionRaw),
    pending: parsePendingLogin(ctx.pendingRaw),
    now: ctx.now,
  });
  return decision.action === 'accept';
}
