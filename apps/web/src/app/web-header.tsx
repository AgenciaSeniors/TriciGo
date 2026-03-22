'use client';

import { useState } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { useAuth } from './providers';

export function WebHeader() {
  const { t } = useTranslation('web');
  const { user, isAuthenticated, isLoading, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const initial = user?.user_metadata?.full_name?.[0]
    ?? user?.email?.[0]?.toUpperCase()
    ?? '?';

  const avatarUrl = user?.user_metadata?.avatar_url;

  const avatarStyle = {
    width: 32,
    height: 32,
    borderRadius: '50%',
    background: 'var(--primary)',
    color: 'white',
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    fontSize: '0.85rem',
    fontWeight: 700 as const,
    overflow: 'hidden' as const,
  };

  function AuthSection({ mobile }: { mobile?: boolean }) {
    if (isLoading) return null;

    if (isAuthenticated) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
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
          <div style={avatarStyle}>
            {avatarUrl ? (
              <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              initial
            )}
          </div>
          <button
            onClick={signOut}
            style={{
              background: 'none',
              border: '1px solid #ddd',
              padding: mobile ? '0.5rem 1rem' : '0.35rem 0.75rem',
              borderRadius: '0.5rem',
              color: '#666',
              cursor: 'pointer',
              fontSize: '0.8rem',
              fontWeight: 500,
            }}
          >
            {t('nav.logout', { defaultValue: 'Salir' })}
          </button>
        </div>
      );
    }

    return (
      <>
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
          href="/blog"
          style={{
            color: '#333',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: '0.9rem',
          }}
        >
          {t('nav.blog')}
        </a>
        <a
          href="/login"
          style={{
            background: 'var(--primary)',
            color: 'white',
            padding: mobile ? '0.75rem' : '0.5rem 1.25rem',
            borderRadius: '0.5rem',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: '0.85rem',
            ...(mobile ? { display: 'block', textAlign: 'center' as const } : {}),
          }}
        >
          {t('nav.login')}
        </a>
      </>
    );
  }

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
          <AuthSection />
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
          <AuthSection mobile />
        </div>
      )}
    </header>
  );
}
