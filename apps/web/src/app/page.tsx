'use client';

import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';

export default function HomePage() {
  const { t } = useTranslation('web');

  const features = [
    { icon: '\u{1F6FA}', titleKey: 'home.feature_triciclos', descKey: 'home.feature_triciclos_desc' },
    { icon: '\u{1F3CD}\uFE0F', titleKey: 'home.feature_motos', descKey: 'home.feature_motos_desc' },
    { icon: '\u{1F697}', titleKey: 'home.feature_autos', descKey: 'home.feature_autos_desc' },
  ];

  return (
    <main
      style={{
        minHeight: 'calc(100vh - 140px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}
    >
      {/* Hero */}
      <div style={{ textAlign: 'center', maxWidth: 600 }}>
        <h1
          style={{
            fontSize: '3rem',
            fontWeight: 800,
            lineHeight: 1.1,
            marginBottom: '1rem',
          }}
        >
          Trici<span style={{ color: 'var(--primary)' }}>Go</span>
        </h1>
        <p
          style={{
            fontSize: '1.25rem',
            color: '#666',
            marginBottom: '2rem',
          }}
        >
          {t('home.tagline')}
        </p>
        <Link
          href="/book"
          style={{
            display: 'inline-block',
            background: 'var(--primary)',
            color: 'white',
            padding: '1rem 2.5rem',
            borderRadius: '0.75rem',
            fontSize: '1.125rem',
            fontWeight: 600,
            textDecoration: 'none',
            transition: 'background 0.2s',
          }}
        >
          {t('home.cta')}
        </Link>
      </div>

      {/* Features */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '2rem',
          marginTop: '4rem',
          maxWidth: 700,
          width: '100%',
        }}
      >
        {features.map((f) => (
          <div
            key={f.titleKey}
            style={{
              textAlign: 'center',
              padding: '1.5rem',
              borderRadius: '1rem',
              border: '1px solid #eee',
            }}
          >
            <span style={{ fontSize: '2rem' }}>{f.icon}</span>
            <h3 style={{ fontWeight: 700, marginTop: '0.5rem' }}>{t(f.titleKey)}</h3>
            <p style={{ color: '#888', fontSize: '0.875rem', marginTop: '0.25rem' }}>
              {t(f.descKey)}
            </p>
          </div>
        ))}
      </div>

    </main>
  );
}
