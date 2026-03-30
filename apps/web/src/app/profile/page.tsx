'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSupabaseClient } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';

/* ── SVG Icons ── */
function IconEdit() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>; }
function IconSettings() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>; }
function IconPin() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" /></svg>; }
function IconShield() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>; }
function IconUsers() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" /></svg>; }
function IconCar() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="3" width="15" height="13" rx="2" ry="2" /><path d="M16 8h4l3 3v5h-7V8z" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /></svg>; }
function IconBuilding() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2" /><path d="M9 22v-4h6v4" /><line x1="8" y1="6" x2="8" y2="6" /><line x1="12" y1="6" x2="12" y2="6" /><line x1="16" y1="6" x2="16" y2="6" /><line x1="8" y1="10" x2="8" y2="10" /><line x1="12" y1="10" x2="12" y2="10" /><line x1="16" y1="10" x2="16" y2="10" /><line x1="8" y1="14" x2="8" y2="14" /><line x1="12" y1="14" x2="12" y2="14" /><line x1="16" y1="14" x2="16" y2="14" /></svg>; }
function IconRepeat() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 014-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 01-4 4H3" /></svg>; }
function IconGift() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 12 20 22 4 22 4 12" /><rect x="2" y="7" width="20" height="5" /><line x1="12" y1="22" x2="12" y2="7" /><path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z" /><path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z" /></svg>; }
function IconHelp() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>; }
function IconInfo() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>; }
function IconBlog() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>; }
function IconChevron() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>; }

const iconMap: Record<string, () => JSX.Element> = {
  'profile.menu_edit': IconEdit,
  'profile.menu_settings': IconSettings,
  'profile.menu_saved_locations': IconPin,
  'profile.menu_safety': IconShield,
  'profile.menu_trusted_contacts': IconUsers,
  'profile.menu_ride_preferences': IconCar,
  'profile.menu_corporate': IconBuilding,
  'profile.menu_recurring_rides': IconRepeat,
  'profile.menu_referral': IconGift,
  'profile.menu_help': IconHelp,
  'profile.menu_about': IconInfo,
  'profile.menu_blog': IconBlog,
};

interface MenuItem {
  labelKey: string;
  href: string;
}

const menuGroups: { titleKey: string; items: MenuItem[] }[] = [
  {
    titleKey: 'profile.group_account',
    items: [
      { labelKey: 'profile.menu_edit', href: '/profile/edit' },
      { labelKey: 'profile.menu_settings', href: '/profile/settings' },
      { labelKey: 'profile.menu_saved_locations', href: '/profile/saved-locations' },
    ],
  },
  {
    titleKey: 'profile.group_safety',
    items: [
      { labelKey: 'profile.menu_safety', href: '/profile/safety' },
      { labelKey: 'profile.menu_trusted_contacts', href: '/profile/trusted-contacts' },
      { labelKey: 'profile.menu_ride_preferences', href: '/profile/ride-preferences' },
    ],
  },
  {
    titleKey: 'profile.group_business',
    items: [
      { labelKey: 'profile.menu_corporate', href: '/profile/corporate' },
      { labelKey: 'profile.menu_recurring_rides', href: '/profile/recurring-rides' },
    ],
  },
  {
    titleKey: 'profile.group_more',
    items: [
      { labelKey: 'profile.menu_referral', href: '/profile/referral' },
      { labelKey: 'profile.menu_help', href: '/profile/help' },
      { labelKey: 'profile.menu_about', href: '/profile/about' },
      { labelKey: 'profile.menu_blog', href: '/blog' },
    ],
  },
];

export default function ProfilePage() {
  const { t } = useTranslation('web');
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);

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
        <div className="spinner" />
      </div>
    );
  }

  if (!userId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
        <p style={{ color: 'var(--text-secondary)' }}>{t('profile.login_prompt')}</p>
        <Link href="/login" className="btn-base btn-primary-solid">
          {t('profile.login_link')}
        </Link>
      </div>
    );
  }

  const avatarUrl = user?.user_metadata?.avatar_url;
  const fullName = user?.user_metadata?.full_name || user?.user_metadata?.name || 'Usuario';
  const email = user?.email || '';
  const level = user?.user_metadata?.level;
  const initial = fullName[0]?.toUpperCase() || '?';

  return (
    <main className="profile-main">
      {/* Avatar Section */}
      <div className="profile-avatar-section">
        <div className="profile-avatar-ring">
          {avatarUrl ? (
            <img src={avatarUrl} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
          ) : (
            <div style={{
              width: '100%', height: '100%', borderRadius: '50%',
              background: 'var(--bg-light)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--primary)',
            }}>
              {initial}
            </div>
          )}
        </div>
        <h1 className="profile-name">{fullName}</h1>
        <p className="profile-email">{email}</p>
        {level && (
          <span className="profile-level-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
            {t('profile.level', { level })}
          </span>
        )}
      </div>

      {/* Menu Groups */}
      <nav aria-label={t('profile.menu_aria')}>
        {menuGroups.map((group) => (
          <div key={group.titleKey} className="profile-menu-group">
            <div className="profile-menu-group-title">
              {t(group.titleKey, { defaultValue: group.titleKey.split('.').pop()?.replace('group_', '') })}
            </div>
            <div className="profile-menu-group-items">
              {group.items.map((item) => {
                const label = t(item.labelKey);
                const Icon = iconMap[item.labelKey];
                return (
                  <Link key={item.href} href={item.href} className="profile-menu-item" aria-label={label}>
                    <span className="profile-menu-icon">
                      {Icon ? <Icon /> : null}
                    </span>
                    <span className="profile-menu-label">{label}</span>
                    <span className="profile-menu-chevron"><IconChevron /></span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Logout */}
      <button
        onClick={handleLogout}
        disabled={loggingOut}
        aria-label={t('profile.logout')}
        className="profile-logout-btn"
        style={{ opacity: loggingOut ? 0.6 : 1, cursor: loggingOut ? 'not-allowed' : 'pointer' }}
      >
        {loggingOut ? t('profile.logging_out') : t('profile.logout')}
      </button>
    </main>
  );
}
