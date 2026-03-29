'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSupabaseClient } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';

export default function ProfilePage() {
  const { t } = useTranslation('web');
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);

  const menuItems = [
    { labelKey: 'profile.menu_edit', href: '/profile/edit', icon: '\u270F\uFE0F' },
    { labelKey: 'profile.menu_settings', href: '/profile/settings', icon: '\u2699\uFE0F' },
    { labelKey: 'profile.menu_saved_locations', href: '/profile/saved-locations', icon: '\uD83D\uDCCD' },
    { labelKey: 'profile.menu_safety', href: '/profile/safety', icon: '\uD83D\uDEE1\uFE0F' },
    { labelKey: 'profile.menu_trusted_contacts', href: '/profile/trusted-contacts', icon: '\uD83D\uDC65' },
    { labelKey: 'profile.menu_emergency_contact', href: '/profile/emergency-contact', icon: '\uD83D\uDCDE' },
    { labelKey: 'profile.menu_ride_preferences', href: '/profile/ride-preferences', icon: '\uD83D\uDE97' },
    { labelKey: 'profile.menu_corporate', href: '/profile/corporate', icon: '\uD83C\uDFE2' },
    { labelKey: 'profile.menu_recurring_rides', href: '/profile/recurring-rides', icon: '\uD83D\uDD01' },
    { labelKey: 'profile.menu_referral', href: '/profile/referral', icon: '\uD83C\uDF81' },
    { labelKey: 'profile.menu_help', href: '/profile/help', icon: '\u2753' },
    { labelKey: 'profile.menu_about', href: '/profile/about', icon: '\u2139\uFE0F' },
    { labelKey: 'profile.menu_blog', href: '/blog', icon: '\uD83D\uDCDD' },
  ];

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
  }, []);

  const handleLogout = async () => {
    setLoggingOut(true);
    await getSupabaseClient().auth.signOut();
    window.location.href = '/';
  };

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>{t('profile.loading')}</p>
      </div>
    );
  }

  if (!userId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
        <p style={{ color: 'var(--text-secondary)' }}>{t('profile.login_prompt')}</p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          {t('profile.login_link')}
        </Link>
      </div>
    );
  }

  const avatarUrl = user?.user_metadata?.avatar_url;
  const fullName = user?.user_metadata?.full_name || user?.user_metadata?.name || 'Usuario';
  const email = user?.email || '';
  const level = user?.user_metadata?.level;

  return (
    <main className="profile-main">
      {/* User Info Card */}
      <div className="profile-avatar-section">
        <div style={{
          width: 80,
          height: 80,
          borderRadius: '50%',
          overflow: 'hidden',
          background: 'var(--border-light)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '1rem',
          border: '3px solid var(--primary)',
        }}>
          {avatarUrl ? (
            <img src={avatarUrl} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <svg width="40" height="40" viewBox="0 0 24 24" fill="#ccc" stroke="none">
              <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
            </svg>
          )}
        </div>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>{fullName}</h1>
        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: '0.25rem 0 0' }}>{email}</p>
        {level && (
          <span style={{
            display: 'inline-block',
            marginTop: '0.5rem',
            padding: '0.25rem 0.75rem',
            background: 'var(--primary)',
            color: '#fff',
            borderRadius: '999px',
            fontSize: '0.75rem',
            fontWeight: 600,
          }}>
            {t('profile.level', { level })}
          </span>
        )}
      </div>

      {/* Menu Items */}
      <nav className="profile-menu" aria-label={t('profile.menu_aria')}>
        {menuItems.map((item, index) => {
          const label = t(item.labelKey);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="profile-menu-item"
              aria-label={label}
              style={{
                borderBottom: index < menuItems.length - 1 ? '1px solid var(--border-light)' : 'none',
              }}
            >
              <span style={{ fontSize: '1.25rem', marginRight: '1rem', width: 28, textAlign: 'center' }}>{item.icon}</span>
              <span style={{ flex: 1, fontSize: '0.95rem', fontWeight: 500 }}>{label}</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--border)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </Link>
          );
        })}
      </nav>

      {/* Logout Button */}
      <button
        onClick={handleLogout}
        disabled={loggingOut}
        aria-label={t('profile.logout')}
        style={{
          display: 'block',
          width: '100%',
          marginTop: '2rem',
          padding: '0.875rem',
          background: 'transparent',
          color: '#e53e3e',
          border: '1px solid #e53e3e',
          borderRadius: '0.75rem',
          fontSize: '0.95rem',
          fontWeight: 600,
          cursor: loggingOut ? 'not-allowed' : 'pointer',
          opacity: loggingOut ? 0.6 : 1,
        }}
      >
        {loggingOut ? t('profile.logging_out') : t('profile.logout')}
      </button>
    </main>
  );
}
