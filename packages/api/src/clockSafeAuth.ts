// ============================================================
// TriciGo — auth that survives a phone clock that is wrong
//
// GoTrue answers every /auth/v1/token call with `expires_at`, computed on the
// SERVER clock, and auth-js keeps it as-is and compares it with the PHONE's
// Date.now(). On 2026-11-01 Cuba kept summer time while phones fell back an
// hour, people set the clock forward by hand, and the phones read UTC an hour
// ahead: a fresh one-hour token looked expired the moment it arrived, so every
// request refreshed the session again (~40 in 20 s) until GoTrue answered 429.
// auth-js treats that 429 as fatal: it deletes the session and fires
// SIGNED_OUT. 16 users were sent to the login screen that day.
//
// Two fixes, both in the fetch every Supabase client here uses:
// 1. anchorSessionExpiry: rewrite `expires_at` as the phone's now + expires_in.
//    The token's lifetime is what matters, and comparing it with the same clock
//    that measures it makes the skew irrelevant. The JWT itself is untouched:
//    the server still validates its own `exp` against its own clock.
// 2. A 429 on a refresh becomes a thrown error, which auth-js reports as
//    AuthRetryableFetchError and never answers by deleting the session. The
//    refresh token was not spent (the request was rejected), so the next
//    attempt refreshes normally. The limit is per IP and Cuban mobile users
//    share IPs behind ETECSA's NAT, so one phone stuck in a loop could
//    otherwise sign out others on the same address.
// ============================================================

const TOKEN_PATH = '/auth/v1/token';

/** A request to GoTrue's token endpoint (password, id_token, refresh_token…). */
export function isAuthTokenUrl(url: string): boolean {
  return url.includes(TOKEN_PATH);
}

/** A session refresh: POST /auth/v1/token?grant_type=refresh_token. */
export function isRefreshTokenUrl(url: string): boolean {
  const i = url.indexOf(TOKEN_PATH);
  if (i < 0) return false;
  const query = url.slice(i + TOKEN_PATH.length);
  return /[?&]grant_type=refresh_token(&|$)/.test(query);
}

/**
 * The thrown error that stands in for a 429 on a refresh. auth-js wraps any
 * thrown fetch error in AuthRetryableFetchError, which keeps the session.
 */
export class RefreshRateLimitedError extends Error {
  constructor() {
    super('Session refresh rate limited (429); keeping the session and retrying later');
    this.name = 'RefreshRateLimitedError';
  }
}

/**
 * Returns the response with `expires_at` measured on this device's clock, or
 * the response itself when there is nothing to rewrite (an error, a body that
 * is not a session, or an `expires_at` that already matches).
 */
export async function anchorSessionExpiry(res: Response, nowMs: number = Date.now()): Promise<Response> {
  if (!res.ok) return res;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) return res;

  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res;
  const session = body as Record<string, unknown>;
  const expiresIn = session.expires_in;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return res;

  const anchored = Math.round(nowMs / 1000) + expiresIn;
  if (session.expires_at === anchored) return res;

  const headers = new Headers(res.headers);
  // The body changes length; a stale value would truncate or hang the read.
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(JSON.stringify({ ...session, expires_at: anchored }), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * What the shared fetch does with every Supabase response: token responses get
 * their expiry anchored to this device, and a 429 on a refresh is thrown
 * instead of returned. Anything else passes through untouched.
 */
export async function adjustAuthResponse(url: string, res: Response): Promise<Response> {
  if (!isAuthTokenUrl(url)) return res;
  if (res.status === 429 && isRefreshTokenUrl(url)) throw new RefreshRateLimitedError();
  return anchorSessionExpiry(res);
}
