'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseClient } from '@tricigo/api';

/**
 * OAuth callback page.
 * Supabase redirects here after Google/Apple login with tokens in the hash.
 * The SDK automatically parses the hash (detectSessionInUrl: true).
 * We wait for the session, then redirect to /book.
 */
export default function AuthCallbackPage() {
  const router = useRouter();
  const handled = useRef(false);

  useEffect(() => {
    const supabase = getSupabaseClient();

    function redirectToBook() {
      if (handled.current) return;
      handled.current = true;
      router.replace('/book');
    }

    // Listen for the SIGNED_IN event from hash parsing
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        redirectToBook();
      }
    });

    // Fallback: if the session was already parsed before listener registered
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) redirectToBook();
    });

    // Safety timeout: if nothing happens in 5s, send to login
    const timeout = setTimeout(() => {
      if (!handled.current) {
        handled.current = true;
        router.replace('/login');
      }
    }, 5000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [router]);

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#fafafa',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem' }}>
          Trici<span style={{ color: 'var(--primary)' }}>Go</span>
        </h1>
        <p style={{ color: '#888', fontSize: '0.9rem' }}>Autenticando...</p>
      </div>
    </main>
  );
}
