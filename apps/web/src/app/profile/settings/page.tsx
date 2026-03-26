'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSupabaseClient } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';

const languages = [
  { code: 'es', label: 'Espanol' },
  { code: 'en', label: 'English' },
  { code: 'pt', label: 'Portugues' },
];

export default function SettingsPage() {
  const { i18n } = useTranslation();
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [language, setLanguage] = useState('es');
  const [pushNotifications, setPushNotifications] = useState(true);
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [smsNotifications, setSmsNotifications] = useState(false);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem('tricigo_language');
    if (saved) {
      setLanguage(saved);
    }
  }, []);

  function handleLanguageChange(code: string) {
    setLanguage(code);
    i18n.changeLanguage(code);
    localStorage.setItem('tricigo_language', code);
    document.documentElement.lang = code;
  }

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
        <p style={{ color: 'var(--text-secondary)' }}>Inicia sesion para ver la configuracion</p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          Iniciar sesion
        </Link>
      </div>
    );
  }

  const toggleStyle = (enabled: boolean): React.CSSProperties => ({
    width: 48,
    height: 28,
    borderRadius: 14,
    background: enabled ? 'var(--primary)' : 'var(--border)',
    position: 'relative',
    cursor: 'pointer',
    transition: 'background 0.2s',
    border: 'none',
    padding: 0,
    flexShrink: 0,
  });

  const toggleKnobStyle = (enabled: boolean): React.CSSProperties => ({
    width: 22,
    height: 22,
    borderRadius: '50%',
    background: 'var(--bg-card)',
    position: 'absolute',
    top: 3,
    left: enabled ? 23 : 3,
    transition: 'left 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
  });

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem', background: 'var(--bg-card)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>Configuracion</h1>
      </div>

      {/* Language Section */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          Idioma
        </h2>
        <div style={{ background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', overflow: 'hidden' }}>
          {languages.map((lang, index) => (
            <button
              key={lang.code}
              onClick={() => handleLanguageChange(lang.code)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: '1rem 1.25rem',
                background: 'transparent',
                border: 'none',
                borderBottom: index < languages.length - 1 ? '1px solid var(--border-light)' : 'none',
                cursor: 'pointer',
                fontSize: '0.95rem',
                color: 'var(--text-primary)',
                textAlign: 'left',
              }}
            >
              <span style={{ fontWeight: language === lang.code ? 600 : 400 }}>{lang.label}</span>
              {language === lang.code && (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--primary)" stroke="none">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                </svg>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Notification Preferences */}
      <div>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          Notificaciones
        </h2>
        <div style={{ background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', overflow: 'hidden' }}>
          {/* Push */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--border-light)',
          }}>
            <div>
              <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>Notificaciones push</p>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Alertas en tiempo real</p>
            </div>
            <button onClick={() => setPushNotifications(!pushNotifications)} style={toggleStyle(pushNotifications)}>
              <div style={toggleKnobStyle(pushNotifications)} />
            </button>
          </div>

          {/* Email */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--border-light)',
          }}>
            <div>
              <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>Correo electronico</p>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Recibos y promociones</p>
            </div>
            <button onClick={() => setEmailNotifications(!emailNotifications)} style={toggleStyle(emailNotifications)}>
              <div style={toggleKnobStyle(emailNotifications)} />
            </button>
          </div>

          {/* SMS */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '1rem 1.25rem',
          }}>
            <div>
              <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>SMS</p>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Actualizaciones por mensaje de texto</p>
            </div>
            <button onClick={() => setSmsNotifications(!smsNotifications)} style={toggleStyle(smsNotifications)}>
              <div style={toggleKnobStyle(smsNotifications)} />
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
