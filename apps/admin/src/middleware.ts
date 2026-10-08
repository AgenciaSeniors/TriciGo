import { NextResponse, type NextRequest } from 'next/server';
import { createMiddlewareClient } from '@/lib/supabase-server';
import { canOpenPanelPath, isPanelRole, panelHome } from '@tricigo/utils/adminPanelAccess';

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

  // Check for valid session
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    const loginUrl = publicUrl(request, '/login');
    loginUrl.searchParams.set('redirect', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Check admin role
  const { data: userData } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  const role: unknown = userData?.role;
  if (!isPanelRole(role)) {
    const loginUrl = publicUrl(request, '/login');
    loginUrl.searchParams.set('error', 'unauthorized');
    return NextResponse.redirect(loginUrl);
  }

  if (!canOpenPanelPath(role, request.nextUrl.pathname)) {
    const redirect = NextResponse.redirect(publicUrl(request, panelHome(role)));
    // Keep any session cookie Supabase refreshed while answering getUser().
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

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
