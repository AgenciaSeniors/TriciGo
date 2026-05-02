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
  ShieldCheck,
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
  Megaphone,
  TrendingUp,
  DollarSign,
  Receipt,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useSidebar } from './SidebarContext';

type NavItem = {
  href: string;
  labelKey: string;
  defaultLabel: string;
  icon: LucideIcon;
};

type NavGroup = {
  id: string;
  titleKey: string;
  defaultTitle: string;
  /** Two-letter marker shown next to the group header (editorial accent) */
  tag: string;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    tag: '01',
    titleKey: 'sidebar.group.overview',
    defaultTitle: 'Panorama',
    items: [
      { href: '/', labelKey: 'sidebar.dashboard', defaultLabel: 'Pulso general', icon: LayoutDashboard },
      { href: '/live-map', labelKey: 'sidebar.live_map', defaultLabel: 'Mapa en vivo', icon: MapPin },
    ],
  },
  {
    id: 'operations',
    tag: '02',
    titleKey: 'sidebar.group.operations',
    defaultTitle: 'Operación',
    items: [
      { href: '/rides', labelKey: 'sidebar.rides', defaultLabel: 'Viajes', icon: Map },
      { href: '/incidents', labelKey: 'sidebar.incidents', defaultLabel: 'Incidentes', icon: AlertTriangle },
      { href: '/disputes', labelKey: 'sidebar.disputes', defaultLabel: 'Disputas', icon: Scale },
      { href: '/lost-found', labelKey: 'sidebar.lost_found', defaultLabel: 'Objetos perdidos', icon: PackageSearch },
      { href: '/fraud', labelKey: 'sidebar.fraud', defaultLabel: 'Antifraude', icon: ShieldAlert },
      { href: '/validation', labelKey: 'sidebar.validation', defaultLabel: 'Validación', icon: ShieldCheck },
    ],
  },
  {
    id: 'people',
    tag: '03',
    titleKey: 'sidebar.group.people',
    defaultTitle: 'Gente',
    items: [
      { href: '/drivers', labelKey: 'sidebar.drivers', defaultLabel: 'Conductores', icon: Car },
      { href: '/users', labelKey: 'sidebar.users', defaultLabel: 'Pasajeros', icon: Users },
      { href: '/wallet', labelKey: 'sidebar.wallet', defaultLabel: 'Billeteras', icon: Wallet },
      { href: '/wallet/receipts', labelKey: 'sidebar.wallet_receipts', defaultLabel: 'Comprobantes', icon: Receipt },
      { href: '/earnings', labelKey: 'sidebar.earnings', defaultLabel: 'Ingresos', icon: DollarSign },
      { href: '/reviews', labelKey: 'sidebar.reviews', defaultLabel: 'Reseñas', icon: Star },
      { href: '/support', labelKey: 'sidebar.support', defaultLabel: 'Soporte', icon: Headphones },
    ],
  },
  {
    id: 'growth',
    tag: '04',
    titleKey: 'sidebar.group.growth',
    defaultTitle: 'Crecimiento',
    items: [
      { href: '/campaigns', labelKey: 'sidebar.campaigns', defaultLabel: 'Campañas', icon: Megaphone },
      { href: '/segments', labelKey: 'sidebar.segments', defaultLabel: 'Segmentos', icon: Users },
      { href: '/referrals', labelKey: 'sidebar.referrals', defaultLabel: 'Referidos', icon: Gift },
      { href: '/quests', labelKey: 'sidebar.quests', defaultLabel: 'Misiones', icon: Trophy },
      { href: '/funnel', labelKey: 'sidebar.funnel', defaultLabel: 'Embudo', icon: TrendingUp },
      { href: '/businesses', labelKey: 'sidebar.businesses', defaultLabel: 'Aliados', icon: Building2 },
    ],
  },
  {
    id: 'content',
    tag: '05',
    titleKey: 'sidebar.group.content',
    defaultTitle: 'Contenido',
    items: [
      { href: '/content', labelKey: 'sidebar.content', defaultLabel: 'Contenido', icon: FileText },
      { href: '/blog', labelKey: 'sidebar.blog', defaultLabel: 'Bitácora', icon: Newspaper },
      { href: '/announcements', labelKey: 'sidebar.announcements', defaultLabel: 'Anuncios home', icon: Sparkles },
      { href: '/notifications', labelKey: 'sidebar.notifications', defaultLabel: 'Avisos push', icon: Bell },
      { href: '/pois', labelKey: 'sidebar.pois', defaultLabel: 'POIs', icon: MapPin },
    ],
  },
  {
    id: 'system',
    tag: '06',
    titleKey: 'sidebar.group.system',
    defaultTitle: 'Sistema',
    items: [
      { href: '/reports', labelKey: 'sidebar.reports', defaultLabel: 'Reportes', icon: BarChart3 },
      { href: '/audit', labelKey: 'sidebar.audit', defaultLabel: 'Auditoría', icon: ClipboardList },
      { href: '/settings/cities', labelKey: 'sidebar.cities', defaultLabel: 'Ciudades', icon: MapPin },
      { href: '/settings', labelKey: 'sidebar.settings', defaultLabel: 'Ajustes', icon: Settings },
    ],
  },
];

function isItemActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();
  const { t } = useTranslation('admin');
  const { isOpen, close, isCollapsed, toggleCollapsed } = useSidebar();

  const width = isCollapsed ? 'md:w-[72px]' : 'md:w-[272px]';

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden animate-fade-in"
          onClick={close}
          aria-hidden="true"
        />
      )}

      <aside
        aria-label="Sidebar"
        className={`
          group/sidebar fixed inset-y-0 left-0 z-50 w-72 flex-shrink-0
          flex flex-col bg-surface-elevated border-r border-line
          transform transition-all duration-300 ease-out
          md:static md:translate-x-0 ${width}
          ${isOpen ? 'translate-x-0 shadow-elev-3' : '-translate-x-full md:translate-x-0'}
        `}
        data-collapsed={isCollapsed ? 'true' : 'false'}
      >
        {/* Brand */}
        <div className="relative flex items-center gap-2.5 px-4 py-5 border-b border-line">
          <Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label="TriciGo Admin">
            <span className="relative flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-500 to-primary-700 font-display text-lg font-bold text-white shadow-glow-primary">
              T
              <span className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-success/70" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
              </span>
            </span>
            {!isCollapsed && (
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-display text-[15px] font-semibold tracking-tight text-ink">
                  TriciGo<span className="text-primary-500">.</span>
                </span>
                <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-subtle">
                  <span className="inline-block h-1 w-1 rounded-full bg-primary-500" aria-hidden="true" />
                  <span>
                    {t('sidebar.admin_panel', { defaultValue: 'Cuba · Panel' })}
                  </span>
                </span>
              </span>
            )}
          </Link>

          <button
            onClick={close}
            className="ml-auto rounded-md p-1.5 text-ink-muted hover:bg-surface-sunken hover:text-ink md:hidden"
            aria-label={t('sidebar.close_menu', { defaultValue: 'Cerrar menú' })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Navigation */}
        <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="space-y-6">
            {NAV_GROUPS.map((group) => (
              <li key={group.id}>
                {!isCollapsed && (
                  <div className="mb-2 flex items-baseline gap-2 px-3">
                    <span className="font-mono text-[10px] font-medium text-ink-subtle">
                      {group.tag}
                    </span>
                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
                      {t(group.titleKey, { defaultValue: group.defaultTitle })}
                    </h3>
                    <span className="flex-1 border-t border-dashed border-line" aria-hidden="true" />
                  </div>
                )}
                {isCollapsed && <div className="mx-auto my-3 h-px w-6 bg-line" />}
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const active = isItemActive(pathname, item.href);
                    const label = t(item.labelKey, { defaultValue: item.defaultLabel });
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={close}
                          aria-current={active ? 'page' : undefined}
                          title={isCollapsed ? label : undefined}
                          className={`
                            group/item relative flex items-center gap-3 rounded-xl px-3 py-2 text-[13px] font-medium transition-all duration-200
                            ${active
                              ? 'bg-gradient-to-r from-primary-500/12 via-primary-500/6 to-transparent text-primary-600 dark:text-primary-400'
                              : 'text-ink-muted hover:bg-surface-sunken hover:text-ink'}
                            ${isCollapsed ? 'md:justify-center md:px-0 md:py-2.5' : ''}
                          `}
                        >
                          {active && (
                            <span
                              className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-primary-500"
                              aria-hidden="true"
                            />
                          )}
                          <item.icon
                            className={`h-[18px] w-[18px] flex-shrink-0 transition-transform duration-200 group-hover/item:scale-110 ${active ? 'scale-110' : ''}`}
                            strokeWidth={active ? 2.2 : 1.75}
                          />
                          <span className={`truncate ${isCollapsed ? 'md:hidden' : ''}`}>
                            {label}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </nav>

        {/* Footer */}
        <div
          className={`flex items-center border-t border-line px-3 py-3 ${isCollapsed ? 'md:justify-center' : 'justify-between'}`}
        >
          {!isCollapsed && (
            <div className="flex flex-col">
              <span className="font-editorial text-[13px] italic text-ink">
                Cuba, en movimiento
              </span>
              <span className="text-[10px] text-ink-subtle">TriciGo · v0.1</span>
            </div>
          )}
          <button
            onClick={toggleCollapsed}
            className="hidden rounded-md p-1.5 text-ink-muted hover:bg-surface-sunken hover:text-ink md:inline-flex"
            aria-label={
              isCollapsed
                ? t('sidebar.expand', { defaultValue: 'Expandir menú' })
                : t('sidebar.collapse', { defaultValue: 'Colapsar menú' })
            }
          >
            {isCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        </div>
      </aside>
    </>
  );
}
