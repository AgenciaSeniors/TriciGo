'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, LogOut, Menu, Moon, Search, Sun, User as UserIcon } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { useAdminUser } from '@/lib/useAdminUser';
import { createBrowserClient } from '@/lib/supabase-server';
import { useSidebar } from './SidebarContext';
import { useTheme } from './ThemeProvider';
import { ProvinceSwitch } from './ProvinceSwitch';

/**
 * Voice: Cuban, movement-first. Prefer verbs that evoke motion and
 * specificity over sterile admin jargon ("Pulso", "Movimiento").
 */
const BREADCRUMB_LABELS: Record<string, string> = {
  '': 'Pulso general',
  drivers: 'Conductores',
  rides: 'Viajes',
  users: 'Pasajeros',
  wallet: 'Billeteras',
  incidents: 'Incidentes',
  support: 'Soporte',
  disputes: 'Disputas',
  reviews: 'Reseñas',
  fraud: 'Antifraude',
  'lost-found': 'Objetos perdidos',
  referrals: 'Referidos',
  segments: 'Segmentos',
  campaigns: 'Campañas',
  notifications: 'Avisos push',
  content: 'Contenido',
  blog: 'Bitácora',
  'live-map': 'Mapa en vivo',
  businesses: 'Aliados',
  quests: 'Misiones',
  audit: 'Auditoría',
  reports: 'Reportes',
  funnel: 'Embudo',
  validation: 'Validación',
  settings: 'Ajustes',
  cities: 'Ciudades',
};

function buildBreadcrumbs(pathname: string) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return [{ href: '/', label: 'Pulso general' }];
  const crumbs: { href: string; label: string }[] = [{ href: '/', label: 'Admin' }];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    const label = BREADCRUMB_LABELS[part] ?? decodeURIComponent(part).replace(/[-_]/g, ' ');
    crumbs.push({ href: acc, label });
  }
  return crumbs;
}

export function Header() {
  const { email, loading } = useAdminUser();
  const pathname = usePathname();
  const router = useRouter();
  const { toggle } = useSidebar();
  const { theme, toggle: toggleTheme } = useTheme();
  const { t } = useTranslation('admin');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const handleLogout = async () => {
    const supabase = createBrowserClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const crumbs = buildBreadcrumbs(pathname);
  const current = crumbs[crumbs.length - 1];
  const initial = email.charAt(0).toUpperCase() || 'A';

  return (
    <header
      aria-label="Admin header"
      className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-surface-elevated/80 px-3 backdrop-blur-xl supports-[backdrop-filter]:bg-surface-elevated/65 md:px-6"
    >
      {/* Mobile hamburger */}
      <button
        onClick={toggle}
        aria-label={t('sidebar.open_menu', { defaultValue: 'Abrir menú' })}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-sunken hover:text-ink md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Breadcrumb */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <nav aria-label="Breadcrumb" className="hidden min-w-0 flex-col md:flex">
          <ol className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-subtle">
            {crumbs.slice(0, -1).map((c, i) => (
              <li key={c.href} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden="true" className="text-ink-subtle/60">/</span>}
                <span className="truncate">{c.label}</span>
              </li>
            ))}
          </ol>
          <h1 className="truncate font-display text-[17px] font-semibold tracking-[-0.02em] text-ink">
            {current?.label}
          </h1>
        </nav>
        <h1 className="truncate font-display text-[15px] font-semibold text-ink md:hidden">
          {current?.label}
        </h1>
      </div>

      {/* Search */}
      <div className="relative hidden lg:block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />
        <input
          ref={searchRef}
          type="search"
          placeholder={t('common.search_placeholder', { defaultValue: 'Buscar viaje, conductor, pasajero…' })}
          aria-label={t('common.search_placeholder', { defaultValue: 'Buscar' })}
          className="h-9 w-80 rounded-lg border border-line bg-surface pl-9 pr-16 text-[13px] text-ink placeholder:text-ink-subtle focus:border-primary-500 focus:outline-none"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 gap-1">
          <kbd className="admin-kbd">⌘</kbd>
          <kbd className="admin-kbd">K</kbd>
        </span>
      </div>

      {/* Actions */}
      <div className="ml-auto flex items-center gap-1.5 md:gap-2">
        <ProvinceSwitch />

        <button
          onClick={toggleTheme}
          aria-label={theme === 'dark'
            ? t('header.light_mode', { defaultValue: 'Pasar a claro' })
            : t('header.dark_mode', { defaultValue: 'Pasar a oscuro' })}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        <button
          aria-label={t('sidebar.notifications', { defaultValue: 'Novedades' })}
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
        >
          <Bell className="h-4 w-4" />
          <span className="absolute right-2 top-2 flex h-2 w-2" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-primary-500 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary-500" />
          </span>
        </button>

        {/* User menu */}
        <div ref={menuRef} className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1 pr-3 hover:bg-surface-sunken"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-primary-500 to-primary-700 font-display text-xs font-semibold text-white">
              {loading ? '…' : initial}
            </span>
            <span className="hidden max-w-[140px] truncate text-xs font-medium text-ink md:inline">
              {loading ? '…' : email}
            </span>
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-line bg-surface-elevated shadow-elev-3 animate-fade-in"
            >
              <div className="flex items-center gap-2.5 border-b border-line px-3 py-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary-500 to-primary-700 font-display text-xs font-semibold text-white">
                  {initial}
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-ink">{email || '—'}</span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                    Administrador
                  </span>
                </div>
              </div>
              <button
                onClick={() => router.push('/settings')}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
                role="menuitem"
              >
                <UserIcon className="h-4 w-4" /> {t('header.profile', { defaultValue: 'Mi perfil' })}
              </button>
              <button
                onClick={handleLogout}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-error hover:bg-error-light/60 dark:hover:bg-error/10"
                role="menuitem"
              >
                <LogOut className="h-4 w-4" /> {t('sidebar.logout', { defaultValue: 'Cerrar sesión' })}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
