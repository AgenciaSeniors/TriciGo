'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSupabaseClient } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';

export default function EditProfilePage() {
  const { t } = useTranslation();
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [originalEmail, setOriginalEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastIsSuccess, setToastIsSuccess] = useState(false);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setUser(session?.user ?? null);
      setAuthLoading(false);
      if (session?.user) {
        const meta = session.user.user_metadata;
        setFullName(meta?.full_name || meta?.name || '');
        setPhone(session.user.phone || meta?.phone || '');
        setEmail(session.user.email || '');
        setOriginalEmail(session.user.email || '');
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
    if (!fullName.trim()) {
      alert(t('web.name_required', { defaultValue: 'El nombre no puede estar vacio' }));
      return;
    }
    const phoneDigits = phone.replace(/\D/g, '');
    if (phone.trim() && phoneDigits.length < 8) {
      alert(t('web.phone_invalid', { defaultValue: 'El telefono debe tener al menos 8 digitos' }));
      return;
    }
    if (email.trim() && !email.includes('@')) {
      alert(t('web.email_invalid', { defaultValue: 'Ingresa un correo electronico valido' }));
      return;
    }
    setSaving(true);
    try {
      const supabase = getSupabaseClient();
      await supabase.auth.updateUser({
        data: { full_name: fullName.trim(), phone: phone.trim() },
      });

      if (email.trim() !== originalEmail) {
        await supabase.auth.updateUser({ email: email.trim() });
      }

      setToastIsSuccess(true);
      setToast(t('web.saved', { defaultValue: 'Guardado' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('web.save_error', { defaultValue: 'Error al guardar' });
      setToastIsSuccess(false);
      setToast(msg);
    } finally {
      setSaving(false);
    }
  };

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>{t('common.loading', { defaultValue: 'Cargando...' })}</p>
      </div>
    );
  }

  if (!userId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
        <p style={{ color: 'var(--text-secondary)' }}>{t('web.login_required_edit', { defaultValue: 'Inicia sesion para editar tu perfil' })}</p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          {t('web.login', { defaultValue: 'Iniciar sesion' })}
        </Link>
      </div>
    );
  }

  const avatarUrl = user?.user_metadata?.avatar_url;

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem', background: 'var(--bg-card)', minHeight: '100vh' }}>
      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed',
          top: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          background: toastIsSuccess ? 'var(--success)' : 'var(--error)',
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
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{t('web.edit_profile', { defaultValue: 'Editar perfil' })}</h1>
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
            {t('web.full_name', { defaultValue: 'Nombre completo' })}
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
            {t('web.email', { defaultValue: 'Correo electronico' })}
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
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
            {t('web.phone', { defaultValue: 'Telefono' })}
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
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

        <button
          onClick={handleSave}
          disabled={saving || !fullName.trim()}
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
          {saving ? t('web.saving', { defaultValue: 'Guardando...' }) : t('web.save_changes', { defaultValue: 'Guardar cambios' })}
        </button>
      </div>
    </main>
  );
}
