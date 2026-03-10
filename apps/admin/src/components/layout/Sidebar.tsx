'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';

const navItems = [
  { href: '/', labelKey: 'sidebar.dashboard', icon: '📊' },
  { href: '/drivers', labelKey: 'sidebar.drivers', icon: '🛺' },
  { href: '/rides', labelKey: 'sidebar.rides', icon: '🗺️' },
  { href: '/users', labelKey: 'sidebar.users', icon: '👥' },
  { href: '/wallet', labelKey: 'sidebar.wallet', icon: '💰' },
  { href: '/incidents', labelKey: 'sidebar.incidents', icon: '🚨' },
  { href: '/support', labelKey: 'sidebar.support', icon: '🎧' },
  { href: '/fraud', labelKey: 'sidebar.fraud', icon: '🛡️' },
  { href: '/audit', labelKey: 'sidebar.audit', icon: '📋' },
  { href: '/reports', labelKey: 'sidebar.reports', icon: '📈' },
  { href: '/settings', labelKey: 'sidebar.settings', icon: '⚙️' },
];

export function Sidebar() {
  const pathname = usePathname();
  const { t } = useTranslation('admin');

  return (
    <aside className="w-64 bg-neutral-950 text-white flex flex-col">
      {/* Logo */}
      <div className="px-6 py-6 border-b border-neutral-800">
        <img
          src="/logo-wordmark-white.png"
          alt="TriciGo"
          className="h-8 w-auto"
        />
        <p className="text-xs text-neutral-500 mt-1">{t('sidebar.admin_panel')}</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`
                flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors
                ${isActive
                  ? 'bg-primary-500/10 text-primary-500'
                  : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
                }
              `}
            >
              <span className="text-lg">{item.icon}</span>
              {t(item.labelKey)}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-neutral-800">
        <p className="text-xs text-neutral-600">TriciGo Admin v0.0.1</p>
      </div>
    </aside>
  );
}
