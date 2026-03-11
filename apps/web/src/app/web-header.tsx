'use client';

import { useState } from 'react';
import { useTranslation } from '@tricigo/i18n';

export function WebHeader() {
  const { t } = useTranslation('web');
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header
      style={{
        borderBottom: '1px solid #eee',
        position: 'sticky',
        top: 0,
        background: 'white',
        zIndex: 50,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '1rem 1.5rem',
          maxWidth: 1200,
          margin: '0 auto',
        }}
      >
        <a href="/" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span style={{ fontSize: '1.5rem', fontWeight: 800 }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </span>
        </a>

        {/* Desktop nav */}
        <nav
          style={{
            gap: '1.5rem',
            alignItems: 'center',
          }}
          className="nav-desktop"
        >
          <a
            href="/book"
            style={{
              color: 'var(--primary)',
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
              background: 'var(--primary)',
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

        {/* Mobile hamburger */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '0.5rem',
            fontSize: '1.5rem',
            lineHeight: 1,
          }}
          className="nav-mobile-toggle"
        >
          {menuOpen ? '\u2715' : '\u2630'}
        </button>
      </div>

      {/* Mobile nav dropdown */}
      {menuOpen && (
        <div
          style={{
            padding: '1rem 1.5rem',
            borderTop: '1px solid #eee',
            gap: '1rem',
          }}
          className="nav-mobile-menu"
        >
          <a
            href="/book"
            style={{
              color: 'var(--primary)',
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
              display: 'block',
              background: 'var(--primary)',
              color: 'white',
              padding: '0.75rem',
              borderRadius: '0.5rem',
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: '0.9rem',
              textAlign: 'center',
            }}
          >
            {t('nav.login')}
          </a>
        </div>
      )}
    </header>
  );
}
