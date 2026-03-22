'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';
import {
  LayoutDashboard,
  Car,
  Map,
  Users,
  Wallet,
  AlertTriangle,
  Headphones,
  Scale,
  ShieldAlert,
  PackageSearch,
  Star,
  ClipboardList,
  BarChart3,
  Settings,
  Gift,
  Bell,
  FileText,
  MapPin,
  Trophy,
  Newspaper,
  Building2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useSidebar } from './SidebarContext';

type NavItem = {
  href: string;
  labelKey: string;
  icon: LucideIcon;
};

const navItems: NavItem[] = [
  { href: '/', labelKey: 'sidebar.dashboard', icon: LayoutDashboard },
  { href: '/drivers', labelKey: 'sidebar.drivers', icon: Car },
  { href: '/rides', labelKey: 'sidebar.rides', icon: Map },
  { href: '/users', labelKey: 'sidebar.users', icon: Users },
  { href: '/wallet', labelKey: 'sidebar.wallet', icon: Wallet },
  { href: '/incidents', labelKey: 'sidebar.incidents', icon: AlertTriangle },
  { href: '/support', labelKey: 'sidebar.support', icon: Headphones },
  { href: '/disputes', labelKey: 'sidebar.disputes', icon: Scale },
  { href: '/reviews', labelKey: 'sidebar.reviews', icon: Star },
  { href: '/fraud', labelKey: 'sidebar.fraud', icon: ShieldAlert },
  { href: '/lost-found', labelKey: 'sidebar.lost_found', icon: PackageSearch },
  { href: '/referrals', labelKey: 'sidebar.referrals', icon: Gift },
  { href: '/notifications', labelKey: 'sidebar.notifications', icon: Bell },
  { href: '/content', labelKey: 'sidebar.content', icon: FileText },
  { href: '/blog', labelKey: 'sidebar.blog', icon: Newspaper },
  { href: '/live-map', labelKey: 'sidebar.live_map', icon: MapPin },
  { href: '/businesses', labelKey: 'sidebar.businesses', icon: Building2 },
  { href: '/quests', labelKey: 'sidebar.quests', icon: Trophy },
  { href: '/audit', labelKey: 'sidebar.audit', icon: ClipboardList },
  { href: '/reports', labelKey: 'sidebar.reports', icon: BarChart3 },
  { href: '/settings', labelKey: 'sidebar.settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const { t } = useTranslation('admin');
  const { isOpen, close } = useSidebar();

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={close}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50 w-64 bg-neutral-950 text-white flex flex-col
          transform transition-transform duration-200 ease-in-out
          md:static md:translate-x-0
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        {/* Logo */}
        <div className="px-6 py-6 border-b border-neutral-800 flex items-center justify-between">
          <div>
            <img src="/logo-wordmark-white.png" alt="TriciGo" className="h-8 w-auto" />
            <p className="text-xs text-neutral-500 mt-1">{t('sidebar.admin_panel')}</p>
          </div>
          <button onClick={close} className="md:hidden p-1 text-neutral-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={close}
                className={`
                  flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors
                  ${isActive
                    ? 'bg-primary-500/10 text-primary-500'
                    : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
                  }
                `}
              >
                <item.icon className="w-5 h-5" />
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
    </>
  );
}
