'use client';

import { useEffect, useState } from 'react';
import { useAdminUser } from '@/lib/useAdminUser';
import { createBrowserClient } from '@/lib/supabase-server';
import { useRouter } from 'next/navigation';
import { useSidebar } from './SidebarContext';
import { Menu, Sun, Moon } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';

export function Header() {
  const { email, loading } = useAdminUser();
  const router = useRouter();
  const { toggle } = useSidebar();
  const { t } = useTranslation('admin');
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('admin-theme');
    if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
      setIsDark(true);
    }
  }, []);

  const toggleDark = () => {
    const newDark = !isDark;
    setIsDark(newDark);
    document.documentElement.classList.toggle('dark', newDark);
    localStorage.setItem('admin-theme', newDark ? 'dark' : 'light');
  };

  const handleLogout = async () => {
    const supabase = createBrowserClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const initial = email.charAt(0).toUpperCase();

  return (
    <header className="h-16 bg-white dark:bg-neutral-800 border-b border-neutral-100 dark:border-neutral-700 flex items-center justify-between px-4 md:px-6">
      <div className="flex items-center gap-3 flex-1">
        {/* Hamburger - mobile only */}
        <button
          onClick={toggle}
          aria-label={t('sidebar.open_menu', { defaultValue: 'Abrir menú' })}
          className="p-2 text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white md:hidden"
        >
          <Menu className="w-5 h-5" />
        </button>
        <input
          type="text"
          placeholder={t('common.search_placeholder', { defaultValue: 'Buscar...' })}
          aria-label={t('common.search_placeholder', { defaultValue: 'Buscar...' })}
          className="px-4 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-200 dark:border-neutral-600 rounded-lg text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus:border-primary-500 w-full md:w-72"
        />
      </div>

      <div className="flex items-center gap-4">
        {/* Dark mode toggle */}
        <button
          onClick={toggleDark}
          className="p-2 text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors"
          title={isDark ? 'Modo claro' : 'Modo oscuro'}
          aria-label={isDark ? t('header.light_mode', { defaultValue: 'Modo claro' }) : t('header.dark_mode', { defaultValue: 'Modo oscuro' })}
        >
          {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>

        {/* Notifications */}
        <button className="relative p-2 text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors" aria-label={t('sidebar.notifications')}>
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
        </button>

        {/* Admin avatar + logout */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-primary-500 flex items-center justify-center">
            <span className="text-white text-sm font-bold">
              {loading ? '...' : initial}
            </span>
          </div>
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300 hidden md:inline">
            {loading ? '...' : email}
          </span>
          <button
            onClick={handleLogout}
            className="ml-2 p-1.5 text-neutral-400 hover:text-red-500 transition-colors"
            title={t('sidebar.logout', { defaultValue: 'Cerrar sesión' })}
            aria-label={t('sidebar.logout', { defaultValue: 'Cerrar sesión' })}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
