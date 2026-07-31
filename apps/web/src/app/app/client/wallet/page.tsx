'use client';

// ============================================================
// TriciGo — Universal Link bridge for the customer app wallet
//
// Landing for `https://tricigo.com/app/client/wallet?intent=<id>`.
//
// When the TriciGo customer app is installed and the device honors
// the universal link (iOS associated domains / Android intent
// filters in apps/client/app.json), the OS intercepts this URL and
// opens the app directly — this page never renders.
//
// If the link is opened on a device without the app installed (or
// universal link verification failed) this page renders a single
// path: "Abrir en TriciGo" — deep-link to
// `tricigo://wallet?intent=<id>` (custom scheme), which is
// guaranteed to open the app if installed even when universal link
// verification is off.
//
// The "Continuar en el navegador" web fallback was removed (mirrors
// the driver bridge fix in commit 9caab52 / PR #145). The recharge
// is already processed server-side by the time the user reaches
// this bridge — the web fallback used to drop mobile users into a
// confusing web wallet that required a separate login, with no
// added benefit. Better to nudge them back into the app where the
// balance is already credited.
//
// Desktop browsers redirect to /wallet upfront since they cannot
// open the app at all.
// ============================================================

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

function isMobileUA(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

export default function ClientAppWalletBridge() {
  const router = useRouter();
  const search = useSearchParams();
  const intent = search?.get('intent') ?? '';

  const [mobile, setMobile] = useState<boolean | null>(null);

  // Desktop → redirect to the web wallet preserving the intent param.
  // Mobile → render the choice UI (universal link did NOT intercept).
  useEffect(() => {
    const m = isMobileUA();
    setMobile(m);
    if (!m) {
      router.replace(intent ? `/wallet?intent=${encodeURIComponent(intent)}` : '/wallet');
    }
  }, [intent, router]);

  // Initial render (SSR / pre-effect): nothing, to avoid flashing the mobile
  // UI before we know the platform.
  if (mobile === null) {
    return null;
  }

  // Desktop: the effect already kicked off router.replace('/wallet'). Render a
  // visible fallback link instead of a blank page, in case that client-side
  // navigation is slow or blocked.
  if (!mobile) {
    return (
      <main className="page-main" style={{ justifyContent: 'center' }}>
        <a
          href={intent ? `/wallet?intent=${encodeURIComponent(intent)}` : '/wallet'}
          className="btn-base btn-primary-solid"
          style={{ minHeight: 52, padding: '0 1.5rem', fontWeight: 700 }}
        >
          Ir a tu billetera
        </a>
      </main>
    );
  }

  const customSchemeUrl = intent
    ? `tricigo://wallet?intent=${encodeURIComponent(intent)}`
    : 'tricigo://wallet';

  return (
    <main className="page-main" style={{ justifyContent: 'center' }}>
      <div
        className="page-container"
        style={{
          maxWidth: 420,
          padding: '2rem 1rem',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '1.5rem',
        }}
      >
        {/* Brand lockup */}
        <div
          aria-label="TriciGo"
          style={{
            fontSize: '1.5rem',
            fontWeight: 800,
            letterSpacing: '-0.01em',
            color: 'var(--text-primary)',
          }}
        >
          Trici<span style={{ color: 'var(--primary)' }}>Go</span>
        </div>

        {/* Visual anchor — gradient banner with return arrow */}
        <div
          aria-hidden
          style={{
            width: '88px',
            height: '88px',
            borderRadius: '24px',
            background: 'var(--gradient-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 12px 32px var(--primary-alpha-20)',
          }}
        >
          {/* Inline SVG (no emoji) — phone-with-arrow back to app */}
          <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="2" width="14" height="20" rx="3" />
            <path d="M9 18h6" />
            <path d="M12 12 L9 9 M9 9 L12 6 M9 9 H15" />
          </svg>
        </div>

        {/* Hero copy */}
        <div style={{ textAlign: 'center', maxWidth: 360 }}>
          <h1
            style={{
              fontSize: 'clamp(1.5rem, 5vw, 1.875rem)',
              fontWeight: 800,
              lineHeight: 1.2,
              letterSpacing: '-0.02em',
              margin: '0 0 0.5rem',
              color: 'var(--text-primary)',
            }}
          >
            Vuelve a TriciGo para ver tu recarga
          </h1>
          <p
            style={{
              fontSize: '0.9375rem',
              lineHeight: 1.55,
              color: 'var(--text-secondary)',
              margin: 0,
            }}
          >
            Procesamos tu pago. Toca <strong style={{ color: 'var(--text-primary)' }}>Abrir en TriciGo</strong> para volver a la app y ver el resultado.
          </p>
        </div>

        {/* CTAs */}
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          <a
            href={customSchemeUrl}
            className="btn-base btn-primary-solid"
            style={{
              width: '100%',
              minHeight: 52,
              fontSize: '1rem',
              fontWeight: 700,
            }}
          >
            Abrir en TriciGo
          </a>
        </div>

        {/* Footnote */}
        <p
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-tertiary)',
            textAlign: 'center',
            margin: '0.25rem 0 0',
            lineHeight: 1.4,
          }}
        >
          Si la app no se abrió automáticamente, toca el botón de arriba o ábrela manualmente — el saldo ya está acreditado en tu cuenta.
        </p>
      </div>
    </main>
  );
}
