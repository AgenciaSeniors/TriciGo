import { NextResponse, type NextRequest } from 'next/server';
import { createMiddlewareClient } from '@/lib/supabase-server';
import {
  PANEL_ROLE_COOKIE,
  canOpenPanelPath,
  isPanelRole,
  panelHome,
  type PanelRole,
} from '@tricigo/utils/adminPanelAccess';
import { invitationOutcomePath, parseAcceptOutcome } from '@tricigo/utils/teamInvitation';

/**
 * Absolute URL on the public admin host. Behind nginx the request URL Next.js
 * sees is the internal one (127.0.0.1:3002, which it even rewrites to
 * localhost), so a redirect built from request.url would send the browser to
 * localhost. Same rule as /auth/callback: prefer the forwarded host. A relative
 * Location is not an option: Next.js parses it without a base and throws.
 */
function publicUrl(request: NextRequest, path: string): URL {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto') ?? 'https';
  const base =
    forwardedHost && process.env.NODE_ENV !== 'development'
      ? `${forwardedProto}://${forwardedHost}`
      : request.nextUrl.origin;
  return new URL(path, base);
}

/**
 * Account lookups, kept for a minute in this server process and shared by
 * requests that arrive together. Opening a page used to cost two calls to
 * Supabase per request (getUser() and the role lookup), and the browser
 * prefetches every menu link at once: 39 requests in 10 s, each with both
 * calls, slowed the panel's own data requests (2026-10-12). The token is now
 * verified locally (getClaims) on every request, and the two calls run once per
 * session and minute:
 *  - getUser() asks GoTrue whether the session still exists, so "sign out
 *    everywhere" (reset password) and a block close the pages within a minute,
 *    as they did when it ran on every request;
 *  - the users row gives the role and is_active.
 * A role change reaches the pages within the same minute. The data and the
 * actions never depended on this check (RLS, RPC gates).
 */
const ACCOUNT_TTL_MS = 60_000;
const ACCOUNT_CACHE_MAX = 500;

interface Account {
  role: unknown;
  active: boolean;
}

/** 'no_session': GoTrue no longer has the session (signed out everywhere, blocked, or unreachable). */
type AccountLookup = Account | 'no_session' | null;

interface AccountEntry {
  at: number;
  lookup: Promise<AccountLookup>;
}

const accountCache = new Map<string, AccountEntry>();

function readAccount(
  supabase: ReturnType<typeof createMiddlewareClient>['supabase'],
  userId: string,
  sessionId: string,
): Promise<AccountLookup> {
  const key = `${userId}:${sessionId}`;
  const now = Date.now();
  const hit = accountCache.get(key);
  if (hit && now - hit.at < ACCOUNT_TTL_MS) return hit.lookup;

  const lookup = (async (): Promise<AccountLookup> => {
    const [auth, row] = await Promise.all([
      supabase.auth.getUser(),
      supabase.from('users').select('role, is_active').eq('id', userId).single(),
    ]);
    if (auth.error || auth.data.user?.id !== userId) return 'no_session';
    if (row.error || !row.data) return null;
    return { role: row.data.role as unknown, active: row.data.is_active !== false };
  })();
  if (accountCache.size >= ACCOUNT_CACHE_MAX) accountCache.clear();
  const entry: AccountEntry = { at: now, lookup };
  accountCache.set(key, entry);
  // A failed lookup is not remembered: the next request asks again.
  void lookup.then(
    (result) => {
      if ((!result || result === 'no_session') && accountCache.get(key) === entry) accountCache.delete(key);
    },
    () => {
      if (accountCache.get(key) === entry) accountCache.delete(key);
    },
  );
  return lookup;
}

/** Forgets every cached lookup of this user: after accepting an invitation the role changed. */
function forgetAccount(userId: string): void {
  for (const key of accountCache.keys()) {
    if (key.startsWith(`${userId}:`)) accountCache.delete(key);
  }
}

/** The verified user and session ids, or null. Any failure (even a thrown one) is "no session". */
async function verifiedSession(
  supabase: ReturnType<typeof createMiddlewareClient>['supabase'],
): Promise<{ userId: string; sessionId: string } | null> {
  try {
    const { data, error } = await supabase.auth.getClaims();
    const claims = data?.claims as Record<string, unknown> | undefined;
    if (error || typeof claims?.sub !== 'string') return null;
    const sessionId = typeof claims.session_id === 'string' ? claims.session_id : 'none';
    return { userId: claims.sub, sessionId };
  } catch {
    // getClaims rethrows anything that is not an AuthError (an expired exp the cookie
    // did not show, an unknown alg, a WebCrypto failure): it is not a session either.
    return null;
  }
}

/** Tells the browser the account's role for drawing the menus (see PANEL_ROLE_COOKIE). */
function rememberRole(request: NextRequest, response: NextResponse, role: PanelRole): void {
  if (request.cookies.get(PANEL_ROLE_COOKIE)?.value === role) return;
  response.cookies.set(PANEL_ROLE_COOKIE, role, {
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV !== 'development',
    maxAge: 60 * 60 * 12,
  });
}

/**
 * Middleware that protects all admin routes.
 *
 * It lives in src/ on purpose: with the app router under src/app, Next.js only
 * loads middleware from src/middleware.ts. At the app root it was never built,
 * so until 2026-10 any signed-in user could open every admin page (the data
 * itself stayed behind RLS and the admin RPCs).
 *
 * Redirects to /login if there is no valid Supabase session or the account is
 * blocked. An account without a panel role (admin, super_admin, marketing or operator)
 * accepts a pending team invitation for its address, or goes to /sin-acceso.
 *
 * Sends an account that opens a page its role cannot open to its home (panelHome). The
 * allow-lists live in @tricigo/utils/adminPanelAccess, the same ones the menus use (00642,
 * 00668).
 */
export async function middleware(request: NextRequest) {
  // Dev-only escape hatch for design previews: /foo?__preview=1
  // Gated by NODE_ENV so it can never run in production builds.
  if (
    process.env.NODE_ENV === 'development' &&
    request.nextUrl.searchParams.has('__preview')
  ) {
    return NextResponse.next();
  }

  const { supabase, response } = createMiddlewareClient(request);

  // Check for valid session. getClaims() verifies the token's signature with the
  // project's public key (cached in this process): no call to Supabase unless the
  // token has expired and must be refreshed. Whether the session still exists and
  // the account's role come from readAccount, once per session and minute.
  const session = await verifiedSession(supabase);
  const account = session ? await readAccount(supabase, session.userId, session.sessionId) : 'no_session';

  if (!session || account === 'no_session') {
    const loginUrl = publicUrl(request, '/login');
    loginUrl.searchParams.set('redirect', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  // A blocked account never gets in, invitation or not.
  if (!account?.active) {
    const loginUrl = publicUrl(request, '/login');
    loginUrl.searchParams.set('error', 'unauthorized');
    const redirect = NextResponse.redirect(loginUrl);
    redirect.cookies.delete(PANEL_ROLE_COOKIE);
    return redirect;
  }

  let role: PanelRole;
  if (isPanelRole(account.role)) {
    role = account.role;
  } else {
    // No panel role: accept a pending invitation for this account's Google or Apple
    // address, if there is one (00661). Otherwise /sin-acceso says why there is no access.
    const { data, error } = await supabase.rpc('accept_team_invitation');
    const outcome = parseAcceptOutcome(error ? null : data);
    if (outcome.result !== 'accepted' || !outcome.role) {
      const redirect = NextResponse.redirect(publicUrl(request, invitationOutcomePath(outcome)));
      for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
      redirect.cookies.delete(PANEL_ROLE_COOKIE);
      return redirect;
    }
    forgetAccount(session.userId);
    role = outcome.role;
  }

  if (!canOpenPanelPath(role, request.nextUrl.pathname)) {
    const redirect = NextResponse.redirect(publicUrl(request, panelHome(role)));
    // Keep any session cookie Supabase refreshed while answering getClaims().
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    rememberRole(request, redirect, role);
    return redirect;
  }

  rememberRole(request, response, role);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all routes except:
     * - /login (auth page)
     * - /auth/callback (OAuth code exchange — must run before any session exists)
     * - /invitacion/*, /sin-acceso (public team invitation pages, 00661)
     * - /_next (Next.js internals)
     * - /favicon.png, /logo-*, /icon-*, /vehicles/* (static assets in public/)
     * - /api (API routes if any)
     */
    '/((?!login|forgot-password|reset-password|auth/callback|invitacion/|sin-acceso|_next|favicon\\.png|logo-|icon-|vehicles/|api).*)',
  ],
};
