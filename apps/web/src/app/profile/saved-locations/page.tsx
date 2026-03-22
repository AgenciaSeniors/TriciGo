'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSupabaseClient } from '@tricigo/api';

const savedLocations = [
  {
    id: 'home',
    label: 'Casa',
    address: null as string | null,
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
  {
    id: 'work',
    label: 'Trabajo',
    address: null as string | null,
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
        <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
      </svg>
    ),
  },
];

const favorites = [
  { id: 'fav1', label: 'Favorito 1', address: null as string | null },
  { id: 'fav2', label: 'Favorito 2', address: null as string | null },
  { id: 'fav3', label: 'Favorito 3', address: null as string | null },
];

export default function SavedLocationsPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setUser(session?.user ?? null);
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
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
        <p style={{ color: 'var(--text-secondary)' }}>Inicia sesion para ver tus ubicaciones</p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          Iniciar sesion
        </Link>
      </div>
    );
  }

  const EditIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem', background: 'var(--bg-card)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>Ubicaciones guardadas</h1>
      </div>

      {/* Home & Work */}
      <div style={{
        background: 'var(--bg-card)',
        borderRadius: '1rem',
        border: '1px solid var(--border-light)',
        overflow: 'hidden',
        marginBottom: '2rem',
      }}>
        {savedLocations.map((loc, index) => (
          <div
            key={loc.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '1rem 1.25rem',
              borderBottom: index < savedLocations.length - 1 ? '1px solid var(--border-light)' : 'none',
            }}
          >
            <div style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              background: 'var(--bg-page)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: '1rem',
              color: 'var(--primary)',
              flexShrink: 0,
            }}>
              {loc.icon}
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>{loc.label}</p>
              <p style={{ margin: '0.2rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                {loc.address || 'Agregar ubicacion'}
              </p>
            </div>
            <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.5rem' }}>
              <EditIcon />
            </button>
          </div>
        ))}
      </div>

      {/* Favorites */}
      <div>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          Favoritos
        </h2>
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: '1rem',
          border: '1px solid var(--border-light)',
          overflow: 'hidden',
        }}>
          {favorites.map((fav, index) => (
            <div
              key={fav.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '1rem 1.25rem',
                borderBottom: index < favorites.length - 1 ? '1px solid var(--border-light)' : 'none',
              }}
            >
              <div style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                background: 'var(--bg-page)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginRight: '1rem',
                flexShrink: 0,
              }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f6ad55" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>{fav.label}</p>
                <p style={{ margin: '0.2rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                  {fav.address || 'Agregar ubicacion'}
                </p>
              </div>
              <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.5rem' }}>
                <EditIcon />
              </button>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
