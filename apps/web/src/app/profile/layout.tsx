'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseClient } from '@tricigo/api';

/**
 * BUG-015 fix: Auth guard layout for all profile/* pages.
 * Redirects unauthenticated users to /login.
 */
export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setIsAuthenticated(true);
      } else {
        router.replace('/login');
      }
      setAuthChecked(true);
    });
  }, [router]);

  if (!authChecked || !isAuthenticated) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary, #ffffff)',
      }}>
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary, #999)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: 'var(--primary, #00C853)' }}>Go</span>
          </div>
          <p style={{ fontSize: '0.875rem' }}>Cargando...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
