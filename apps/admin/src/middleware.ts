import { NextResponse, type NextRequest } from 'next/server';
import { createMiddlewareClient } from '@/lib/supabase-server';
import {
  PANEL_ROLE_COOKIE,
  canOpenPanelPath,
  isPanelRole,
  panelHome,
  type PanelRole,
} from '@tricigo/utils/adminPanelAccess';

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
 * Role lookups, kept for a minute in this server process and shared by requests
 * that arrive together. Opening a page used to cost two calls to Supabase per
 * request (getUser() and this lookup), and the browser prefetches every menu
 * link at once: 39 requests in 10 s, each with both calls, slowed the panel's
 * own data requests (2026-10-12). The session is now verified locally
 * (getClaims), so a request in that burst costs at most one lookup per user.
 * A role change or a block reaches the pages within a minute; the data and the
 * actions never depended on this check (RLS, RPC gates).
 */
const ROLE_TTL_MS = 60_000;
const ROLE_CACHE_MAX = 500;

interface RoleEntry {
  at: number;
  lookup: Promise<{ role: unknown; active: boolean } | null>;
}

const roleCache = new Map<string, RoleEntry>();

function readRole(
  supabase: ReturnType<typeof createMiddlewareClient>['supabase'],
  userId: string,
): Promise<{ role: unknown; active: boolean } | null> {
  const now = Date.now();
  const hit = roleCache.get(userId);
  if (hit && now - hit.at < ROLE_TTL_MS) return hit.lookup;

  const lookup = (async () => {
    const { data, error } = await supabase
      .from('users')
      .select('role, is_active')
      .eq('id', userId)
      .single();
    if (error || !data) return null;
    return { role: data.role as unknown, active: data.is_active !== false };
  })();
  if (roleCache.size >= ROLE_CACHE_MAX) roleCache.clear();
  const entry: RoleEntry = { at: now, lookup };
  roleCache.set(userId, entry);
  // A failed lookup is not remembered: the next request asks again.
  void lookup.then(
    (result) => {
      if (!result && roleCache.get(userId) === entry) roleCache.delete(userId);
    },
    () => {
      if (roleCache.get(userId) === entry) roleCache.delete(userId);
    },
  );
  return lookup;
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
 * Redirects to /login if:
 *  - No valid Supabase session
 *  - User does not have a panel role (admin, super_admin or marketing)
 *
 * Sends a marketing account that opens a page outside its allow-list to its home
 * (@tricigo/utils/adminPanelAccess, the same list the menus use, 00642).
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
  // token has expired and must be refreshed. A blocked account keeps a valid token
  // for up to an hour, so the lookup below also checks is_active.
  const { data: claimsData, error } = await supabase.auth.getClaims();
  const userId = typeof claimsData?.claims?.sub === 'string' ? claimsData.claims.sub : null;

  if (error || !userId) {
    const loginUrl = publicUrl(request, '/login');
    loginUrl.searchParams.set('redirect', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Check admin role
  const account = await readRole(supabase, userId);
  const role: unknown = account?.role;
  if (!account?.active || !isPanelRole(role)) {
    const loginUrl = publicUrl(request, '/login');
    loginUrl.searchParams.set('error', 'unauthorized');
    const redirect = NextResponse.redirect(loginUrl);
    redirect.cookies.delete(PANEL_ROLE_COOKIE);
    return redirect;
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
     * - /_next (Next.js internals)
     * - /favicon.png, /logo-*, /icon-*, /vehicles/* (static assets in public/)
     * - /api (API routes if any)
     */
    '/((?!login|forgot-password|reset-password|auth/callback|_next|favicon\\.png|logo-|icon-|vehicles/|api).*)',
  ],
};
