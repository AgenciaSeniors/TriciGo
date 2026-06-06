import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * OAuth callback handler for the admin panel.
 *
 * Google/Apple sign-in (PKCE flow via @supabase/ssr) returns here with a
 * `?code=`. We exchange it for a session server-side so the auth cookies are
 * set before any protected route runs its middleware check. Without this
 * handler the browser would land on `/` with an un-exchanged code, the
 * middleware would find no session and bounce back to /login — an endless loop.
 *
 * REQUIRES `https://admin.tricigo.com/**` in Supabase Auth → URL Configuration
 * → Redirect URLs. Otherwise GoTrue discards the redirect and falls back to the
 * project Site URL (tricigo.com), which is the bug this fixes.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  // Open-redirect guard: only same-origin relative paths (mirrors login page).
  const rawNext = url.searchParams.get('redirect') ?? '/';
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  // Behind nginx the internal request host is 127.0.0.1:3002; prefer the
  // forwarded host so redirects go back to the public admin.tricigo.com.
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto') ?? 'https';
  const base =
    forwardedHost && process.env.NODE_ENV !== 'development'
      ? `${forwardedProto}://${forwardedHost}`
      : url.origin;

  if (code) {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          },
        },
      },
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${base}${next}`);
    }
  }

  return NextResponse.redirect(`${base}/login?error=oauth`);
}
