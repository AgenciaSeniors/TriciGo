'use client';

import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseClient, referralService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';

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
  const { t } = useTranslation('web');
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
      setErrorMsg(t('refer.invalid_code', { defaultValue: 'Código de referido inválido.' }));
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
  }, [code, router, t]);

  const iconBg =
    status === 'applied'
      ? 'rgba(34, 197, 94, 0.12)'
      : status === 'failed'
        ? 'rgba(239, 68, 68, 0.12)'
        : 'var(--primary-alpha-10)';

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-lg)',
      }}
    >
      <div
        style={{
          background: 'var(--bg-card)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-xl)',
          maxWidth: 420,
          width: '100%',
          padding: 'var(--space-xl)',
          textAlign: 'center',
        }}
      >
        {/* Brand */}
        <div style={{ marginBottom: 'var(--space-lg)' }}>
          <h1 style={{ fontSize: 'var(--text-3xl)', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </h1>
        </div>

        {/* Icon shifts with the status so the page feels alive even
            without copy changes. */}
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: 'var(--radius-full)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto var(--space-lg)',
            background: iconBg,
          }}
        >
          <span style={{ fontSize: '2.25rem', lineHeight: 1 }}>
            {status === 'applied' ? '✓' : status === 'failed' ? '!' : '🎁'}
          </span>
        </div>

        <h2 style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 var(--space-sm)' }}>
          {status === 'applied'
            ? t('refer.applied_title', { defaultValue: '¡Código aplicado!' })
            : status === 'failed'
              ? t('refer.failed_title', { defaultValue: 'No se pudo aplicar' })
              : t('refer.invited_title', { defaultValue: '¡Te invitaron a TriciGo!' })}
        </h2>

        <p style={{ color: 'var(--text-secondary)', margin: '0 0 var(--space-sm)', lineHeight: 1.5 }}>
          {status === 'applied'
            ? t('refer.applied_desc', { defaultValue: 'Tu invitador recibirá su bono cuando completes tu primer viaje.' })
            : status === 'failed'
              ? (errorMsg ?? t('refer.failed_desc', { defaultValue: 'Inténtalo de nuevo más tarde.' }))
              : status === 'applying'
                ? t('refer.applying', { defaultValue: 'Aplicando código...' })
                : t('refer.invited_desc', { defaultValue: 'Cuando completes tu primer viaje, tu invitador recibirá un bono en TriciCoins.' })}
        </p>

        {/* Code chip — always visible so the rider can copy it
            manually if anything goes off-rails. */}
        <div
          style={{
            background: 'var(--bg-light)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-md) var(--space-lg)',
            margin: 'var(--space-lg) 0',
            border: '2px dashed var(--primary)',
          }}
        >
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', margin: '0 0 var(--space-xs)' }}>
            {t('refer.code_label', { defaultValue: 'Código de referido' })}
          </p>
          <p
            style={{
              fontSize: 'var(--text-2xl)',
              fontWeight: 800,
              letterSpacing: '0.15em',
              color: 'var(--primary)',
              fontFamily: 'monospace',
              margin: 0,
            }}
          >
            {code}
          </p>
        </div>

        {/* CTAs depend on status. We always offer the deep link to
            the native app — Universal Links handle the mobile case;
            on desktop the link is a no-op fallback under the visible
            web actions. */}
        {status === 'applied' && (
          <Link href="/book" className="btn-base btn-primary-solid" style={primaryCtaStyle}>
            {t('refer.cta_book', { defaultValue: 'Pedir mi primer viaje' })}
          </Link>
        )}

        {status === 'guest' && (
          <>
            <Link href={`/login?ref=${code}`} className="btn-base btn-primary-solid" style={primaryCtaStyle}>
              {t('refer.cta_login', { defaultValue: 'Iniciar sesión y aplicar' })}
            </Link>
            <a href={appDeepLink} className="btn-base btn-secondary-outline" style={primaryCtaStyle}>
              {t('refer.cta_open_app', { defaultValue: 'Abrir en la app TriciGo' })}
            </a>
          </>
        )}

        {status === 'failed' && (
          <Link href="/profile/referral" className="btn-base btn-primary-solid" style={primaryCtaStyle}>
            {t('refer.cta_my_code', { defaultValue: 'Ir a mi código' })}
          </Link>
        )}

        {/* Fallback note + brand link, always visible. */}
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginTop: 'var(--space-md)' }}>
          {t('refer.no_app', { defaultValue: '¿No tenés la app? Descargala desde la App Store o Google Play.' })}
        </p>
        <Link
          href="/"
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--primary)',
            textDecoration: 'none',
            marginTop: 'var(--space-md)',
            display: 'inline-block',
          }}
        >
          {t('refer.visit_site', { defaultValue: 'Visitar tricigo.com' })}
        </Link>
      </div>
    </div>
  );
}

/**
 * Shared style for the full-width CTA links. Layered on top of the
 * `.btn-base` + `.btn-primary-solid`/`.btn-secondary-outline` classes
 * from globals.css so the buttons match the rest of the web app while
 * still spanning the card width with a roomier vertical rhythm.
 */
const primaryCtaStyle: CSSProperties = {
  display: 'flex',
  width: '100%',
  padding: 'var(--space-md) var(--space-lg)',
  borderRadius: 'var(--radius-lg)',
  fontSize: 'var(--text-lg)',
  marginBottom: 'var(--space-sm)',
};
