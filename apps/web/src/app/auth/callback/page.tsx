'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseClient, authService, referralService } from '@tricigo/api';
import { registerWebLoginDevice } from '@/lib/webDevice';

// Mirror of LoginPage's PENDING_REFERRAL_KEY — the referral code may
// have been stashed before the OAuth round-trip, and now (with a
// session in hand) is the right time to redeem it.
const PENDING_REFERRAL_KEY = 'tricigo_pending_referral';

async function applyPendingReferralIfAny(uid: string): Promise<void> {
  let code: string | null = null;
  try { code = sessionStorage.getItem(PENDING_REFERRAL_KEY); } catch { return; }
  if (!code) return;
  try {
    await referralService.applyReferralCode(uid, code);
  } catch (err) {
    console.warn('[auth/callback] applyReferralCode failed:', err);
  } finally {
    try { sessionStorage.removeItem(PENDING_REFERRAL_KEY); } catch { /* ignore */ }
  }
}

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

    async function finishAndRedirect(uid: string | undefined) {
      if (handled.current) return;
      handled.current = true;
      if (uid) {
        await applyPendingReferralIfAny(uid);
        registerWebLoginDevice();
        // Route by profile completeness (parity con el guard de _layout móvil):
        // OAuth users often lack a name and always lack a phone at first login.
        try {
          const profile = await authService.getUserById(uid);
          if (!profile?.full_name) { router.replace('/complete-profile'); return; }
          if (!profile?.phone) { router.replace('/verify-phone'); return; }
        } catch { /* fall through to /book on lookup failure */ }
      }
      router.replace('/book');
    }

    // Listen for the SIGNED_IN event from hash parsing
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        finishAndRedirect(session?.user?.id);
      }
    });

    // Fallback: if the session was already parsed before listener registered
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) finishAndRedirect(session.user?.id);
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
        background: 'var(--bg-page)',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.5rem' }}>
          Trici<span style={{ color: 'var(--primary)' }}>Go</span>
        </h1>
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>Autenticando...</p>
      </div>
    </main>
  );
}
