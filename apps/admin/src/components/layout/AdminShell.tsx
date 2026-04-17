'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { initI18n } from '@tricigo/i18n';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { BottomNav } from './BottomNav';
import { SidebarProvider } from './SidebarContext';
import { ThemeProvider } from './ThemeProvider';
import { AdminToastProvider } from '@/components/ui/AdminToast';
import { useAdminUser } from '@/lib/useAdminUser';

let i18nInitialized = false;

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isAuthPage =
    pathname === '/login' ||
    pathname === '/forgot-password' ||
    pathname === '/reset-password';
  const [ready, setReady] = useState(i18nInitialized);
  const { user, loading: authLoading } = useAdminUser();

  useEffect(() => {
    if (!i18nInitialized) {
      initI18n();
      i18nInitialized = true;
      setReady(true);
    }
  }, []);

  // Allow design-preview routes (dev only) to render without a session.
  // Mirrors the guard in middleware.ts.
  const bypassAuth =
    typeof window !== 'undefined' &&
    process.env.NODE_ENV === 'development' &&
    new URLSearchParams(window.location.search).has('__preview');

  useEffect(() => {
    if (bypassAuth) return;
    if (!authLoading && !user && !isAuthPage) {
      router.replace('/login');
    }
  }, [authLoading, user, isAuthPage, router, bypassAuth]);

  if (!ready) return null;

  if (isAuthPage) {
    return (
      <ThemeProvider>
        <AdminToastProvider>{children}</AdminToastProvider>
      </ThemeProvider>
    );
  }

  if (!bypassAuth && (authLoading || !user)) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-sunken">
        <div className="relative h-10 w-10">
          <div className="absolute inset-0 animate-spin rounded-full border-4 border-primary-500/20 border-t-primary-500" />
        </div>
      </div>
    );
  }

  return (
    <ThemeProvider>
      <AdminToastProvider>
        <SidebarProvider>
          <div className="flex h-dvh bg-surface-sunken text-ink">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <Header />
              <main
                id="main-content"
                className="relative flex-1 overflow-y-auto pb-20 md:pb-6"
              >
                <div className="mx-auto w-full max-w-[1600px] px-4 py-5 md:px-6 md:py-7">
                  {children}
                </div>
              </main>
            </div>
            <BottomNav />
          </div>
        </SidebarProvider>
      </AdminToastProvider>
    </ThemeProvider>
  );
}
