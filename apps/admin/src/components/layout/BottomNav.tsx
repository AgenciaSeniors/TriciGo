'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Headphones, LayoutDashboard, Map, MapPin, MoreHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { useSidebar } from './SidebarContext';

type Item = {
  href: string;
  labelKey: string;
  defaultLabel: string;
  icon: LucideIcon;
  matchPrefix?: boolean;
};

const ITEMS: Item[] = [
  { href: '/', labelKey: 'sidebar.dashboard', defaultLabel: 'Pulso', icon: LayoutDashboard },
  { href: '/rides', labelKey: 'sidebar.rides', defaultLabel: 'Viajes', icon: Map, matchPrefix: true },
  { href: '/live-map', labelKey: 'sidebar.live_map', defaultLabel: 'Mapa', icon: MapPin, matchPrefix: true },
  { href: '/support', labelKey: 'sidebar.support', defaultLabel: 'Soporte', icon: Headphones, matchPrefix: true },
];

export function BottomNav() {
  const pathname = usePathname();
  const { toggle } = useSidebar();
  const { t } = useTranslation('admin');

  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface-elevated/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
    >
      <ul className="grid grid-cols-5">
        {ITEMS.map((item) => {
          const active = item.matchPrefix
            ? pathname.startsWith(item.href)
            : pathname === item.href;
          const label = t(item.labelKey, { defaultValue: item.defaultLabel });
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                aria-label={label}
                className={`flex min-h-[56px] flex-col items-center justify-center gap-1 px-1 py-1.5 text-[10px] font-medium transition-colors ${
                  active ? 'text-primary-500' : 'text-ink-muted hover:text-ink'
                }`}
              >
                <span className="relative">
                  <item.icon className="h-5 w-5" strokeWidth={active ? 2.2 : 1.75} />
                  {active && (
                    <span
                      className="absolute -top-2 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-primary-500"
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span className="truncate">{label}</span>
              </Link>
            </li>
          );
        })}
        <li>
          <button
            onClick={toggle}
            aria-label={t('sidebar.open_menu', { defaultValue: 'Abrir menú' })}
            className="flex min-h-[56px] w-full flex-col items-center justify-center gap-1 px-1 py-1.5 text-[10px] font-medium text-ink-muted hover:text-ink"
          >
            <MoreHorizontal className="h-5 w-5" strokeWidth={1.75} />
            <span>{t('sidebar.more', { defaultValue: 'Más' })}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
