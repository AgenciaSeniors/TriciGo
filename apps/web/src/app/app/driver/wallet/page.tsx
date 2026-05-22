'use client';

// ============================================================
// TriciGo — Universal Link bridge for the driver app wallet
//
// Landing for `https://tricigo.com/app/driver/wallet?intent=<id>`.
// Mirrors apps/web/src/app/app/client/wallet/page.tsx — only the
// brand label and custom scheme differ
// (`tricigo-driver://wallet?intent=<id>`).
// ============================================================

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

function isMobileUA(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

export default function DriverAppWalletBridge() {
  const router = useRouter();
  const search = useSearchParams();
  const intent = search?.get('intent') ?? '';

  const [mobile, setMobile] = useState<boolean | null>(null);

  useEffect(() => {
    const m = isMobileUA();
    setMobile(m);
    if (!m) {
      router.replace(intent ? `/wallet?intent=${encodeURIComponent(intent)}` : '/wallet');
    }
  }, [intent, router]);

  if (mobile === null || mobile === false) {
    return null;
  }

  const customSchemeUrl = intent
    ? `tricigo-driver://wallet?intent=${encodeURIComponent(intent)}`
    : 'tricigo-driver://wallet';
  // No web fallback here: the driver wallet only exists in the mobile
  // app (no `/wallet/driver` web surface). If the universal link to
  // `tricigo-driver://` fails to open the app, the only correct path
  // is for the driver to open the app manually — the recharge is
  // already credited server-side by the time we land on this page.

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
          aria-label="TriciGo Conductor"
          style={{
            fontSize: '1.5rem',
            fontWeight: 800,
            letterSpacing: '-0.01em',
            color: 'var(--text-primary)',
            display: 'flex',
            alignItems: 'baseline',
            gap: '0.5rem',
          }}
        >
          <span>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </span>
          <span
            style={{
              fontSize: '0.6875rem',
              fontWeight: 700,
              padding: '0.15rem 0.45rem',
              borderRadius: '999px',
              background: 'var(--primary-alpha-10)',
              color: 'var(--primary)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Conductor
          </span>
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
            Volvé a la app para ver tu recarga
          </h1>
          <p
            style={{
              fontSize: '0.9375rem',
              lineHeight: 1.55,
              color: 'var(--text-secondary)',
              margin: 0,
            }}
          >
            Procesamos tu pago. Tocá <strong style={{ color: 'var(--text-primary)' }}>Abrir en TriciGo Conductor</strong> para volver a la app y ver el resultado.
          </p>
        </div>

        {/* CTAs — only the open-in-app action. The recharge is already
            credited server-side by the webhook; the browser fallback that
            used to live here pointed at /wallet (rider surface), which
            confused drivers, so it was removed in PR #145. */}
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
            Abrir en TriciGo Conductor
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
          Si la app no se abrió automáticamente, tocá el botón de arriba o abrila manualmente — el saldo ya está acreditado en tu cuenta.
        </p>
      </div>
    </main>
  );
}
