import { createBrowserClient as _createBrowserClient, createServerClient as _createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Create a Supabase client for use in the browser (client components).
 */
export function createBrowserClient() {
  return _createBrowserClient(supabaseUrl, supabaseAnonKey);
}

/**
 * Create a Supabase client for use in Next.js middleware.
 * Reads/writes auth tokens via request/response cookies.
 */
export function createMiddlewareClient(request: NextRequest) {
  const response = NextResponse.next({ request: { headers: request.headers } });

  const supabase = _createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  return { supabase, response };
}
