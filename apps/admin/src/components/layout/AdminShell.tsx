'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { Header } from './Header';

/**
 * Conditionally renders the admin chrome (sidebar + header).
 * The /login page renders without chrome.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === '/login';

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
