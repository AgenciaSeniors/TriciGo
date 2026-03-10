'use client';

import { useTranslation } from '@tricigo/i18n';

export function WebHeader() {
  const { t } = useTranslation('web');

  return (
    <header
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '1rem 2rem',
        borderBottom: '1px solid #eee',
        position: 'sticky',
        top: 0,
        background: 'white',
        zIndex: 50,
      }}
    >
      <a href="/" style={{ textDecoration: 'none', color: 'inherit' }}>
        <span style={{ fontSize: '1.5rem', fontWeight: 800 }}>
          Trici<span style={{ color: '#FF4D00' }}>Go</span>
        </span>
      </a>
      <nav style={{ display: 'flex', gap: '1.5rem', alignItems: 'center' }}>
        <a
          href="/book"
          style={{
            color: '#FF4D00',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: '0.9rem',
          }}
        >
          {t('nav.book_ride')}
        </a>
        <a
          href="/login"
          style={{
            background: '#FF4D00',
            color: 'white',
            padding: '0.5rem 1.25rem',
            borderRadius: '0.5rem',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: '0.85rem',
          }}
        >
          {t('nav.login')}
        </a>
      </nav>
    </header>
  );
}
