'use client';

import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';

export default function HomePage() {
  const { t } = useTranslation('web');

  const features = [
    { label: 'TC', titleKey: 'home.feature_triciclos', descKey: 'home.feature_triciclos_desc' },
    { label: 'MT', titleKey: 'home.feature_motos', descKey: 'home.feature_motos_desc' },
    { label: 'AT', titleKey: 'home.feature_autos', descKey: 'home.feature_autos_desc' },
  ];

  return (
    <main
      style={{
        minHeight: 'calc(100vh - 140px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
      }}
    >
      {/* Hero */}
      <div style={{ textAlign: 'center', maxWidth: 600, width: '100%' }}>
        <h1
          style={{
            fontSize: 'clamp(2rem, 5vw, 3rem)',
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
            <div style={{
              width: 48, height: 48, borderRadius: '50%',
              background: 'var(--primary)', color: 'white',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 700, fontSize: '0.875rem', margin: '0 auto 0.5rem',
            }}>
              {f.label}
            </div>
            <h3 style={{ fontWeight: 700, marginTop: '0.5rem' }}>{t(f.titleKey)}</h3>
            <p style={{ color: '#888', fontSize: '0.875rem', marginTop: '0.25rem' }}>
              {t(f.descKey)}
            </p>
          </div>
        ))}
      </div>

      {/* Download section */}
      <div
        style={{
          marginTop: '4rem',
          textAlign: 'center',
          maxWidth: 500,
          width: '100%',
        }}
      >
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>
          {t('home.download_title')}
        </h2>
        <p style={{ color: '#888', fontSize: '0.95rem', marginBottom: '1.5rem' }}>
          {t('home.download_subtitle')}
        </p>
        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <a
            href="https://play.google.com/store/apps/details?id=app.tricigo.client"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              background: '#111',
              color: 'white',
              padding: '0.75rem 1.5rem',
              borderRadius: '0.75rem',
              textDecoration: 'none',
              fontSize: '0.875rem',
              fontWeight: 600,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.199l2.807 1.626a1 1 0 010 1.732l-2.807 1.626L15.206 12l2.492-2.492zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z" />
            </svg>
            Google Play
          </a>
          <a
            href="https://apps.apple.com/app/tricigo/id000000000"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              background: '#111',
              color: 'white',
              padding: '0.75rem 1.5rem',
              borderRadius: '0.75rem',
              textDecoration: 'none',
              fontSize: '0.875rem',
              fontWeight: 600,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
            </svg>
            App Store
          </a>
        </div>
      </div>

    </main>
  );
}
