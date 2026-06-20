'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseClient } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';

// Shared with /book so the code survives the guest → login round-trip.
const PENDING_PROMO_KEY = 'tricigo_pending_promo';

/**
 * Web landing page for promo code deep links.
 * URL: https://tricigo.com/promo/{code}
 *
 * On mobile with the app installed, Universal Links opens the app. On the web:
 *   - Already authenticated → route to /book?promo={code}; /book pre-fills the
 *     promo field so the rider doesn't have to retype it.
 *   - Not authenticated → stash the code in sessionStorage and show the landing
 *     with a "log in" CTA (after login, /book reads the pending key) plus the
 *     download / open-app fallback.
 */
export default function PromoLandingPage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useTranslation('web');
  const code = ((params.code as string) ?? '').trim();

  const appDeepLink = `tricigo://promo/${code}`;
  const [isGuest, setIsGuest] = useState(false);
  // Guard against React StrictMode's dev double-invoke.
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current || !code) return;
    ranRef.current = true;
    (async () => {
      try {
        const { data: { session } } = await getSupabaseClient().auth.getSession();
        if (session?.user?.id) {
          // Authenticated → hand the code to the booking flow, which validates
          // it once a fare estimate exists.
          router.replace(`/book?promo=${encodeURIComponent(code)}`);
          return;
        }
      } catch { /* fall through to guest */ }
      try { sessionStorage.setItem(PENDING_PROMO_KEY, code); } catch { /* ignore */ }
      setIsGuest(true);
    })();
  }, [code, router]);

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
        {/* Logo */}
        <div style={{ marginBottom: 'var(--space-lg)' }}>
          <h1 style={{ fontSize: 'var(--text-3xl)', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </h1>
        </div>

        {/* Discount icon */}
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: 'var(--radius-full)',
            background: 'rgba(34, 197, 94, 0.12)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto var(--space-lg)',
          }}
        >
          <span style={{ fontSize: '2.25rem', lineHeight: 1 }}>🏷️</span>
        </div>

        <h2 style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 var(--space-sm)' }}>
          {t('promo.title', { defaultValue: '¡Tienes un descuento!' })}
        </h2>

        <p style={{ color: 'var(--text-secondary)', margin: '0 0 var(--space-sm)', lineHeight: 1.5 }}>
          {t('promo.subtitle', { defaultValue: 'Aplica este código promocional en tu próximo viaje con TriciGo.' })}
        </p>

        {/* Promo code display */}
        <div
          style={{
            background: 'var(--bg-light)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-md) var(--space-lg)',
            marginBottom: 'var(--space-lg)',
            border: '2px dashed var(--success)',
          }}
        >
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', margin: '0 0 var(--space-xs)' }}>
            {t('promo.code_label', { defaultValue: 'Código promocional' })}
          </p>
          <p
            style={{
              fontSize: 'var(--text-2xl)',
              fontWeight: 800,
              letterSpacing: '0.15em',
              color: 'var(--success)',
              fontFamily: 'monospace',
              margin: 0,
            }}
          >
            {code}
          </p>
        </div>

        {/* Logged-in riders: apply on the web. Guests: log in to use it. */}
        {isGuest && (
          <Link
            href="/login"
            className="btn-base btn-primary-solid"
            style={{
              display: 'flex',
              width: '100%',
              padding: 'var(--space-md) var(--space-lg)',
              borderRadius: 'var(--radius-lg)',
              fontSize: 'var(--text-lg)',
              marginBottom: 'var(--space-sm)',
            }}
          >
            {t('promo.login_cta', { defaultValue: 'Iniciar sesión y usar el código' })}
          </Link>
        )}

        {/* Open app button */}
        <a
          href={appDeepLink}
          className="btn-base btn-primary-solid"
          style={{
            display: 'flex',
            width: '100%',
            padding: 'var(--space-md) var(--space-lg)',
            borderRadius: 'var(--radius-lg)',
            fontSize: 'var(--text-lg)',
            marginBottom: 'var(--space-sm)',
            ...(isGuest ? { background: 'transparent', color: 'var(--primary)', border: '1px solid var(--primary)' } : {}),
          }}
        >
          {t('promo.open_app', { defaultValue: 'Abrir en TriciGo' })}
        </a>

        {/* Fallback text */}
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginTop: 'var(--space-md)' }}>
          {t('promo.no_app', { defaultValue: '¿No tienes la app? Descárgala desde la App Store o Google Play.' })}
        </p>

        {/* Home link */}
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
          {t('promo.visit_site', { defaultValue: 'Visitar tricigo.com' })}
        </Link>
      </div>
    </div>
  );
}
