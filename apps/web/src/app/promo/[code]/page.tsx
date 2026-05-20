'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';

/**
 * Web landing page for promo code deep links.
 * URL: https://tricigo.com/promo/{code}
 *
 * On mobile with app installed: Universal Links opens the app directly.
 * On web/without app: Shows this landing page with download CTA.
 */
export default function PromoLandingPage() {
  const params = useParams();
  const code = params.code as string;

  const appDeepLink = `tricigo://promo/${code}`;

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
          ¡Tienes un descuento!
        </h2>

        <p style={{ color: 'var(--text-secondary)', margin: '0 0 var(--space-sm)', lineHeight: 1.5 }}>
          Aplica este código promocional en tu próximo viaje con TriciGo.
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
            Código promocional
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
          }}
        >
          Abrir en TriciGo
        </a>

        {/* Fallback text */}
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginTop: 'var(--space-md)' }}>
          ¿No tienes la app? Descárgala desde la App Store o Google Play.
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
          Visitar tricigo.com
        </Link>
      </div>
    </div>
  );
}
