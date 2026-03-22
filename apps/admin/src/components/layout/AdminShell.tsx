'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { initI18n } from '@tricigo/i18n';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { SidebarProvider } from './SidebarContext';
import { AdminToastProvider } from '@/components/ui/AdminToast';
import { useAdminUser } from '@/lib/useAdminUser';

let i18nInitialized = false;

/**
 * Conditionally renders the admin chrome (sidebar + header).
 * The /login page renders without chrome.
 * Also initialises i18n for the admin app and guards against
 * unauthenticated access (prevents flash of admin content).
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isAuthPage = pathname === '/login' || pathname === '/forgot-password' || pathname === '/reset-password';
  const [ready, setReady] = useState(i18nInitialized);
  const { user, loading: authLoading } = useAdminUser();

  useEffect(() => {
    if (!i18nInitialized) {
      initI18n();
      i18nInitialized = true;
      setReady(true);
    }
  }, []);

  // Redirect to login if not authenticated (client-side guard)
  useEffect(() => {
    if (!authLoading && !user && !isAuthPage) {
      router.replace('/login');
    }
  }, [authLoading, user, isAuthPage, router]);

  if (!ready) return null;

  if (isAuthPage) {
    return <AdminToastProvider>{children}</AdminToastProvider>;
  }

  // Show loading spinner while checking auth
  if (authLoading || !user) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-50 dark:bg-neutral-900">
        <div className="animate-spin h-8 w-8 border-4 border-orange-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <AdminToastProvider>
      <SidebarProvider>
        <div className="flex h-screen">
          <Sidebar />
          <div className="flex-1 flex flex-col overflow-hidden">
            <Header />
            <main className="flex-1 overflow-y-auto p-4 md:p-6 bg-neutral-50 dark:bg-neutral-900">
              {children}
            </main>
          </div>
        </div>
      </SidebarProvider>
    </AdminToastProvider>
  );
}
