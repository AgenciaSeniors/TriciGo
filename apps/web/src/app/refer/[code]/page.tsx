'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseClient, referralService } from '@tricigo/api';

// Mirror of the key used by /login and /auth/callback so the code
// survives an OAuth round-trip.
const PENDING_REFERRAL_KEY = 'tricigo_pending_referral';

type Status = 'idle' | 'applying' | 'applied' | 'failed' | 'guest';

/**
 * Web landing page for referral deep links.
 *
 * URL: https://tricigo.com/refer/{code}
 *
 * On mobile with the app installed, Universal Links should open the
 * native app. This page is the fallback for desktop and for mobile
 * users without the app, plus the entry point when an existing web
 * rider clicks a friend's code.
 *
 * Behavior:
 *   - Already authenticated → apply the code immediately, show
 *     success, and redirect to /book.
 *   - Not authenticated → stash the code in sessionStorage and
 *     route the user to /login?ref={code}. The login flow (and the
 *     OAuth callback) read the same key and redeem on session.
 */
export default function ReferralLandingPage() {
  const params = useParams();
  const router = useRouter();
  const rawCode = (params.code as string) ?? '';
  const code = rawCode.trim().toUpperCase();
  const appDeepLink = `tricigo://refer/${code}`;

  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Hard guard against React StrictMode's double-invoke of effects
  // in dev — one apply attempt per mount is enough.
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    if (!code) {
      setStatus('failed');
      setErrorMsg('Código de referido inválido.');
      return;
    }

    (async () => {
      try {
        const supabase = getSupabaseClient();
        const { data: { session } } = await supabase.auth.getSession();
        const uid = session?.user?.id;

        if (!uid) {
          // Guest path: persist code, expose CTA to log in / open the
          // app. We don't auto-redirect to /login here so the rider
          // can read the page (and tap "Open in app") if they prefer
          // the native flow.
          try { sessionStorage.setItem(PENDING_REFERRAL_KEY, code); } catch { /* ignore */ }
          setStatus('guest');
          return;
        }

        // Authenticated path: apply immediately. Failures (invalid
        // code, self-referral, already-applied) surface inline so
        // the rider knows why no bonus was credited.
        setStatus('applying');
        try {
          await referralService.applyReferralCode(uid, code);
          setStatus('applied');
          // Brief pause so the success state is readable, then route
          // to /book where the rider will likely act next.
          setTimeout(() => router.replace('/book'), 1800);
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
          setStatus('failed');
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus('failed');
      }
    })();
  }, [code, router]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center p-6">
      <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 text-center">
        {/* Brand */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold">
            Trici<span className="text-orange-500">Go</span>
          </h1>
        </div>

        {/* Icon shifts with the status so the page feels alive even
            without copy changes. */}
        <div
          className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 ${
            status === 'applied' ? 'bg-green-100' : status === 'failed' ? 'bg-red-100' : 'bg-orange-100'
          }`}
        >
          <span className="text-4xl">
            {status === 'applied' ? '✓' : status === 'failed' ? '!' : '🎁'}
          </span>
        </div>

        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          {status === 'applied'
            ? '¡Código aplicado!'
            : status === 'failed'
              ? 'No se pudo aplicar'
              : '¡Te invitaron a TriciGo!'}
        </h2>

        <p className="text-gray-600 mb-2">
          {status === 'applied'
            ? 'Tu invitador recibirá su bono cuando completes tu primer viaje.'
            : status === 'failed'
              ? (errorMsg ?? 'Inténtalo de nuevo más tarde.')
              : status === 'applying'
                ? 'Aplicando código...'
                : 'Cuando completes tu primer viaje, tu invitador recibirá un bono en TriciCoins.'}
        </p>

        {/* Code chip — always visible so the rider can copy it
            manually if anything goes off-rails. */}
        <div className="bg-gray-50 rounded-xl px-6 py-4 my-6 border-2 border-dashed border-orange-300">
          <p className="text-sm text-gray-500 mb-1">Código de referido</p>
          <p className="text-2xl font-bold tracking-widest text-orange-600 font-mono">{code}</p>
        </div>

        {/* CTAs depend on status. We always offer the deep link to
            the native app — Universal Links handle the mobile case;
            on desktop the link is a no-op fallback under the visible
            web actions. */}
        {status === 'applied' && (
          <Link
            href="/book"
            className="block w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-4 px-6 rounded-2xl mb-3 transition-colors"
          >
            Pedir mi primer viaje
          </Link>
        )}

        {status === 'guest' && (
          <>
            <Link
              href={`/login?ref=${code}`}
              className="block w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-4 px-6 rounded-2xl mb-3 transition-colors"
            >
              Iniciar sesión y aplicar
            </Link>
            <a
              href={appDeepLink}
              className="block w-full bg-white border border-orange-500 text-orange-600 font-semibold py-4 px-6 rounded-2xl mb-3 transition-colors hover:bg-orange-50"
            >
              Abrir en la app TriciGo
            </a>
          </>
        )}

        {status === 'failed' && (
          <Link
            href="/profile/referral"
            className="block w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-4 px-6 rounded-2xl mb-3 transition-colors"
          >
            Ir a mi código
          </Link>
        )}

        {/* Fallback note + brand link, always visible. */}
        <p className="text-sm text-gray-400 mt-4">
          ¿No tenés la app? Descargala desde la App Store o Google Play.
        </p>
        <Link href="/" className="text-sm text-orange-500 hover:underline mt-4 inline-block">
          Visitar tricigo.com
        </Link>
      </div>
    </div>
  );
}
