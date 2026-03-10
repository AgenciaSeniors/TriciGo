'use client';

import { useAdminUser } from '@/lib/useAdminUser';
import { createBrowserClient } from '@/lib/supabase-server';
import { useRouter } from 'next/navigation';

export function Header() {
  const { email, loading } = useAdminUser();
  const router = useRouter();

  const handleLogout = async () => {
    const supabase = createBrowserClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const initial = email.charAt(0).toUpperCase();

  return (
    <header className="h-16 bg-white border-b border-neutral-100 flex items-center justify-between px-6">
      <div className="flex items-center gap-4">
        <input
          type="text"
          placeholder="Buscar..."
          className="px-4 py-2 bg-neutral-50 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-primary-500 w-72"
        />
      </div>

      <div className="flex items-center gap-4">
        {/* Notifications */}
        <button className="relative p-2 text-neutral-500 hover:text-neutral-900 transition-colors">
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
          <span className="text-sm font-medium text-neutral-700">
            {loading ? '...' : email}
          </span>
          <button
            onClick={handleLogout}
            className="ml-2 p-1.5 text-neutral-400 hover:text-red-500 transition-colors"
            title="Cerrar sesión"
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
