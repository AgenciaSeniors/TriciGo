'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, notificationService } from '@tricigo/api';
import type { User } from '@supabase/supabase-js';

export function WebHeader() {
  const { t } = useTranslation('web');
  const [menuOpen, setMenuOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pathname, setPathname] = useState('/');
  const [isDark, setIsDark] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    setPathname(window.location.pathname);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem('tricigo-theme');
    if (saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      setIsDark(true);
    } else if (saved === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      setIsDark(false);
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (prefersDark) {
        setIsDark(true);
      }
    }
  }, []);

  const toggleDark = () => {
    const newDark = !isDark;
    setIsDark(newDark);
    if (newDark) {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('tricigo-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('tricigo-theme', 'light');
    }
  };

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

  useEffect(() => {
    if (!user) return;
    notificationService.getUnreadCount(user.id).then(setUnreadCount).catch(() => {});
    const sub = notificationService.subscribeToNotifications(user.id, () => {
      notificationService.getUnreadCount(user.id).then(setUnreadCount).catch(() => {});
    });
    return () => { sub?.unsubscribe?.(); };
  }, [user]);

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

  const DarkToggle = () => (
    <button
      onClick={toggleDark}
      aria-label="Toggle dark mode"
      style={{
        background: 'var(--bg-hover)',
        border: 'none',
        cursor: 'pointer',
        width: 36,
        height: 36,
        borderRadius: 'var(--radius-sm)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background var(--transition-fast)',
      }}
    >
      {isDark ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );

  function NotificationBadge({ size = 'sm' }: { size?: 'sm' | 'md' }) {
    if (unreadCount <= 0) return null;
    const isSm = size === 'sm';
    return (
      <span
        className="badge-pulse"
        style={{
          position: isSm ? 'absolute' : 'static',
          top: isSm ? -6 : undefined,
          right: isSm ? -10 : undefined,
          minWidth: isSm ? 16 : 18,
          height: isSm ? 16 : 18,
          borderRadius: 'var(--radius-full)',
          background: 'var(--primary)',
          color: '#fff',
          fontSize: '0.6rem',
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 4px',
        }}
      >
        {unreadCount > 9 ? '9+' : unreadCount}
      </span>
    );
  }

  function AuthNav({ mobile }: { mobile?: boolean }) {
    if (isLoading) return null;

    if (isAuthenticated) {
      const links = [
        { href: '/book', label: t('nav.book_ride') },
        { href: '/rides', label: t('nav.rides') },
        { href: '/wallet', label: t('nav.wallet') },
        { href: '/notifications', label: t('nav.notifications') },
        { href: '/profile', label: t('nav.profile') },
      ];

      if (mobile) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                style={{
                  color: pathname.startsWith(l.href) ? 'var(--primary)' : 'var(--text-primary)',
                  textDecoration: 'none',
                  fontWeight: pathname.startsWith(l.href) ? 600 : 500,
                  fontSize: 'var(--text-md)',
                  padding: '0.75rem 0.5rem',
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  transition: 'background var(--transition-fast)',
                  background: pathname.startsWith(l.href) ? 'var(--primary-alpha-10)' : 'transparent',
                }}
              >
                {l.label}
                {l.href === '/notifications' && <NotificationBadge size="md" />}
              </a>
            ))}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              paddingTop: '0.75rem',
              marginTop: '0.5rem',
              borderTop: '1px solid var(--border-light)',
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%',
                background: 'var(--gradient-primary)', color: 'white',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.85rem', fontWeight: 700, overflow: 'hidden',
              }}>
                {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initial}
              </div>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', flex: 1, fontWeight: 500 }}>
                {user?.user_metadata?.full_name || user?.email}
              </span>
              <button
                onClick={signOut}
                aria-label={t('nav.logout')}
                style={{
                  background: 'none',
                  border: '1px solid var(--border)',
                  padding: '0.4rem 0.75rem',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: 'var(--text-xs)',
                  fontFamily: 'inherit',
                  fontWeight: 500,
                }}
              >
                {t('nav.logout')}
              </button>
            </div>
          </div>
        );
      }

      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="nav-link-animated"
              style={{
                color: pathname.startsWith(l.href) ? 'var(--primary)' : undefined,
                position: 'relative',
                fontWeight: pathname.startsWith(l.href) ? 600 : undefined,
                fontSize: 'var(--text-base)',
              }}
              aria-label={l.label}
            >
              {l.label}
              {l.href === '/notifications' && <NotificationBadge />}
            </a>
          ))}
          <div style={{
            width: 34, height: 34, borderRadius: '50%',
            background: 'var(--gradient-primary)', color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.8rem', fontWeight: 700, overflow: 'hidden',
            boxShadow: 'var(--shadow-sm)',
          }} aria-label="Avatar de usuario">
            {avatarUrl ? <img src={avatarUrl} alt="Foto de perfil" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initial}
          </div>
          <button
            onClick={signOut}
            aria-label={t('nav.logout')}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              padding: '0.35rem 0.75rem',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 'var(--text-xs)',
              fontWeight: 500,
              fontFamily: 'inherit',
              transition: 'all var(--transition-fast)',
            }}
          >
            {t('nav.logout')}
          </button>
        </div>
      );
    }

    return (
      <>
        <a href="/book" className="nav-link-animated" style={{ fontSize: 'var(--text-base)' }}>{t('nav.book_ride')}</a>
        <a href="/blog" className="nav-link-animated" style={{ fontSize: 'var(--text-base)' }}>{t('nav.blog')}</a>
        <a
          href="/login"
          className="btn-base btn-primary-solid"
          style={{
            padding: mobile ? '0.75rem' : '0.5rem 1.25rem',
            fontSize: 'var(--text-sm)',
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
      className="header-glass"
      style={{ position: 'sticky', top: 0, zIndex: 50 }}
    >
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0.75rem 1.5rem',
        maxWidth: 1200,
        margin: '0 auto',
      }}>
        <a href="/" style={{ textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center' }} aria-label="Ir a inicio de TriciGo">
          <img
            src={isDark ? '/logo-wordmark-white.png' : '/logo-wordmark.png'}
            alt="TriciGo"
            style={{ height: 28, width: 'auto' }}
          />
        </a>

        <nav style={{ gap: '1.5rem', alignItems: 'center' }} className="nav-desktop" aria-label="Navegacion principal">
          <AuthNav />
          <DarkToggle />
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} className="nav-mobile-toggle">
          <DarkToggle />
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label={menuOpen ? t('nav.close_menu') : t('nav.open_menu')}
            aria-expanded={menuOpen}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '0.5rem',
              fontSize: '1.4rem',
              lineHeight: 1,
              color: 'var(--text-primary)',
            }}
          >
            {menuOpen ? '\u2715' : '\u2630'}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div
          style={{
            padding: '0.5rem 1.5rem 1rem',
            borderTop: '1px solid var(--border-light)',
          }}
          className="nav-mobile-menu"
        >
          <AuthNav mobile />
        </div>
      )}
    </header>
  );
}
