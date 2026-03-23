'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseClient } from '@tricigo/api';

export default function AboutPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>Cargando...</p>
      </div>
    );
  }

  if (!userId) {
    router.replace('/login');
    return null;
  }

  const linkItems = [
    { label: 'Politica de privacidad', href: '/privacy' },
    { label: 'Terminos y condiciones', href: '/terms' },
    { label: 'Blog', href: '/blog' },
  ];

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>Acerca de</h1>
      </div>

      {/* App Info */}
      <div style={{
        background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)',
        padding: '2rem', textAlign: 'center', marginBottom: '1.5rem',
      }}>
        <div style={{
          width: 72, height: 72, borderRadius: '1rem', background: 'var(--primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 1rem', fontSize: '2rem', color: '#fff', fontWeight: 800,
        }}>
          T
        </div>
        <h2 style={{ margin: '0 0 0.25rem', fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>TriciGo</h2>
        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>Version 1.0.0</p>
        <p style={{ margin: '0.75rem 0 0', fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          La plataforma de movilidad de Cuba. Conectamos pasajeros con conductores de triciclos y taxis de forma segura y conveniente.
        </p>
      </div>

      {/* Links */}
      <div style={{
        background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)',
        overflow: 'hidden', marginBottom: '1.5rem',
      }}>
        {linkItems.map((item, index) => (
          <Link
            key={item.href}
            href={item.href}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '1rem 1.25rem', textDecoration: 'none', color: 'var(--text-primary)',
              borderBottom: index < linkItems.length - 1 ? '1px solid var(--border-light)' : 'none',
            }}
          >
            <span style={{ fontSize: '0.95rem', fontWeight: 500 }}>{item.label}</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--border)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </Link>
        ))}
      </div>

      {/* Contact */}
      <div style={{
        background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)',
        padding: '1.25rem',
      }}>
        <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Contacto
        </h3>
        <a
          href="mailto:soporte@tricigo.com"
          style={{ color: 'var(--primary)', fontSize: '0.95rem', fontWeight: 500, textDecoration: 'none' }}
        >
          soporte@tricigo.com
        </a>
        <p style={{ margin: '0.75rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          TriciGo Inc. La Habana, Cuba.
        </p>
      </div>
    </main>
  );
}
