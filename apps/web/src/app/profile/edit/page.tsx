'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSupabaseClient } from '@tricigo/api';

export default function EditProfilePage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [fullName, setFullName] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setUser(session?.user ?? null);
      setAuthLoading(false);
      if (session?.user) {
        const meta = session.user.user_metadata;
        setFullName(meta?.full_name || meta?.name || '');
      }
    });
  }, []);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 2500);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await getSupabaseClient().auth.updateUser({
        data: { full_name: fullName },
      });
      setToast('Guardado');
    } catch {
      setToast('Error al guardar');
    } finally {
      setSaving(false);
    }
  };

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
        <p style={{ color: 'var(--text-secondary)' }}>Inicia sesion para editar tu perfil</p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          Iniciar sesion
        </Link>
      </div>
    );
  }

  const avatarUrl = user?.user_metadata?.avatar_url;
  const email = user?.email || '';
  const phone = user?.phone || user?.user_metadata?.phone || '';

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem', background: 'var(--bg-card)', minHeight: '100vh' }}>
      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed',
          top: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          background: toast === 'Guardado' ? 'var(--success)' : 'var(--error)',
          color: '#fff',
          padding: '0.75rem 1.5rem',
          borderRadius: '0.75rem',
          fontSize: '0.9rem',
          fontWeight: 600,
          zIndex: 1000,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          {toast}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>Editar perfil</h1>
      </div>

      {/* Avatar */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '2rem' }}>
        <div style={{
          width: 96,
          height: 96,
          borderRadius: '50%',
          overflow: 'hidden',
          background: 'var(--border-light)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '3px solid var(--primary)',
        }}>
          {avatarUrl ? (
            <img src={avatarUrl} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <svg width="48" height="48" viewBox="0 0 24 24" fill="#ccc" stroke="none">
              <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
            </svg>
          )}
        </div>
      </div>

      {/* Form */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            Nombre completo
          </label>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            style={{
              width: '100%',
              padding: '0.75rem 1rem',
              border: '1px solid var(--border)',
              borderRadius: '0.75rem',
              fontSize: '0.95rem',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            Correo electronico
          </label>
          <input
            type="email"
            value={email}
            readOnly
            style={{
              width: '100%',
              padding: '0.75rem 1rem',
              border: '1px solid var(--border-light)',
              borderRadius: '0.75rem',
              fontSize: '0.95rem',
              background: 'var(--bg-page)',
              color: 'var(--text-tertiary)',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            Telefono
          </label>
          <input
            type="tel"
            value={phone}
            readOnly
            style={{
              width: '100%',
              padding: '0.75rem 1rem',
              border: '1px solid var(--border-light)',
              borderRadius: '0.75rem',
              fontSize: '0.95rem',
              background: 'var(--bg-page)',
              color: 'var(--text-tertiary)',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            marginTop: '0.5rem',
            padding: '0.875rem',
            background: 'var(--primary)',
            color: '#fff',
            border: 'none',
            borderRadius: '0.75rem',
            fontSize: '0.95rem',
            fontWeight: 600,
            cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? 'Guardando...' : 'Guardar cambios'}
        </button>
      </div>
    </main>
  );
}
