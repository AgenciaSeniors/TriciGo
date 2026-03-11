'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { initI18n } from '@tricigo/i18n';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { SidebarProvider } from './SidebarContext';

let i18nInitialized = false;

/**
 * Conditionally renders the admin chrome (sidebar + header).
 * The /login page renders without chrome.
 * Also initialises i18n for the admin app.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === '/login';
  const [ready, setReady] = useState(i18nInitialized);

  useEffect(() => {
    if (!i18nInitialized) {
      initI18n();
      i18nInitialized = true;
      setReady(true);
    }
  }, []);

  if (!ready) return null;

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <SidebarProvider>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <Header />
          <main className="flex-1 overflow-y-auto p-4 md:p-6">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
