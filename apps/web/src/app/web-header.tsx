'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient } from '@tricigo/api';
import type { User } from '@supabase/supabase-js';

const navLinkStyle = (active?: boolean) => ({
  color: active ? 'var(--primary)' : '#555',
  textDecoration: 'none' as const,
  fontWeight: 600 as const,
  fontSize: '0.9rem' as const,
  borderBottom: active ? '2px solid var(--primary)' : '2px solid transparent',
  paddingBottom: '0.25rem',
});

export function WebHeader() {
  const { t } = useTranslation('web');
  const [menuOpen, setMenuOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pathname, setPathname] = useState('/');

  useEffect(() => {
    setPathname(window.location.pathname);
  }, []);

  useEffect(() => {
    const supabase = getSupabaseClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setIsLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
        setIsLoading(false);
      },
    );
    return () => subscription.unsubscribe();
  }, []);

  const isAuthenticated = !!user;

  const signOut = async () => {
    const supabase = getSupabaseClient();
    await supabase.auth.signOut();
    setUser(null);
    window.location.href = '/';
  };

  const initial = user?.user_metadata?.full_name?.[0]
    ?? user?.email?.[0]?.toUpperCase()
    ?? '?';
  const avatarUrl = user?.user_metadata?.avatar_url;

  const avatarStyle = {
    width: 32, height: 32, borderRadius: '50%',
    background: 'var(--primary)', color: 'white',
    display: 'flex' as const, alignItems: 'center' as const, justifyContent: 'center' as const,
    fontSize: '0.85rem', fontWeight: 700 as const, overflow: 'hidden' as const,
  };

  function AuthNav({ mobile }: { mobile?: boolean }) {
    if (isLoading) return null;

    if (isAuthenticated) {
      const links = [
        { href: '/book', label: t('nav.book_ride', { defaultValue: 'Reservar' }) },
        { href: '/rides', label: t('nav.rides', { defaultValue: 'Viajes' }) },
        { href: '/wallet', label: t('nav.wallet', { defaultValue: 'Wallet' }) },
        { href: '/profile', label: t('nav.profile', { defaultValue: 'Perfil' }) },
      ];

      if (mobile) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {links.map((l) => (
              <a key={l.href} href={l.href} style={{ ...navLinkStyle(pathname.startsWith(l.href)), fontSize: '1rem', paddingBottom: 0, borderBottom: 'none' }}>
                {l.label}
              </a>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid #eee' }}>
              <div style={avatarStyle}>
                {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initial}
              </div>
              <span style={{ fontSize: '0.85rem', color: '#333', flex: 1 }}>{user?.user_metadata?.full_name || user?.email}</span>
              <button onClick={signOut} style={{ background: 'none', border: '1px solid #ddd', padding: '0.4rem 0.75rem', borderRadius: '0.5rem', color: '#666', cursor: 'pointer', fontSize: '0.8rem' }}>
                {t('nav.logout', { defaultValue: 'Salir' })}
              </button>
            </div>
          </div>
        );
      }

      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          {links.map((l) => (
            <a key={l.href} href={l.href} style={navLinkStyle(pathname.startsWith(l.href))}>
              {l.label}
            </a>
          ))}
          <div style={avatarStyle}>
            {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initial}
          </div>
          <button onClick={signOut} style={{ background: 'none', border: '1px solid #ddd', padding: '0.35rem 0.75rem', borderRadius: '0.5rem', color: '#666', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 500 }}>
            {t('nav.logout', { defaultValue: 'Salir' })}
          </button>
        </div>
      );
    }

    return (
      <>
        <a href="/book" style={navLinkStyle()}>{t('nav.book_ride')}</a>
        <a href="/blog" style={navLinkStyle()}>{t('nav.blog')}</a>
        <a href="/login" style={{ background: 'var(--primary)', color: 'white', padding: mobile ? '0.75rem' : '0.5rem 1.25rem', borderRadius: '0.5rem', textDecoration: 'none', fontWeight: 600, fontSize: '0.85rem', ...(mobile ? { display: 'block', textAlign: 'center' as const } : {}) }}>
          {t('nav.login')}
        </a>
      </>
    );
  }

  return (
    <header style={{ borderBottom: '1px solid #eee', position: 'sticky', top: 0, background: 'white', zIndex: 50 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.5rem', maxWidth: 1200, margin: '0 auto' }}>
        <a href="/" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span style={{ fontSize: '1.5rem', fontWeight: 800 }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </span>
        </a>
        <nav style={{ gap: '1.5rem', alignItems: 'center' }} className="nav-desktop">
          <AuthNav />
        </nav>
        <button onClick={() => setMenuOpen(!menuOpen)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.5rem', fontSize: '1.5rem', lineHeight: 1 }} className="nav-mobile-toggle">
          {menuOpen ? '\u2715' : '\u2630'}
        </button>
      </div>
      {menuOpen && (
        <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid #eee', gap: '1rem' }} className="nav-mobile-menu">
          <AuthNav mobile />
        </div>
      )}
    </header>
  );
}
