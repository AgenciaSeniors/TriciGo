'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSupabaseClient, notificationService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';

const languages = [
  { code: 'es', label: 'Espanol' },
  { code: 'en', label: 'English' },
  { code: 'pt', label: 'Portugues' },
];

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [language, setLanguage] = useState('es');
  const [pushNotifications, setPushNotifications] = useState(true);
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [smsNotifications, setSmsNotifications] = useState(false);
  const [prefsLoading, setPrefsLoading] = useState(false);
  const [darkMode, setDarkMode] = useState<'light' | 'dark' | 'system'>('system');

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
    const savedTheme = localStorage.getItem('tricigo_theme') as 'light' | 'dark' | 'system' | null;
    if (savedTheme) {
      setDarkMode(savedTheme);
    }
  }, []);

  // Load notification preferences from DB
  useEffect(() => {
    if (!userId) return;
    setPrefsLoading(true);
    Promise.all([
      notificationService.getPreferences(userId),
      notificationService.getSmsPreference(userId),
    ]).then(([prefs, sms]) => {
      if (prefs) {
        setPushNotifications(prefs.ride_updates);
        setEmailNotifications(prefs.promotions);
      }
      setSmsNotifications(sms);
    }).catch(() => {}).finally(() => setPrefsLoading(false));
  }, [userId]);

  async function handleTogglePush() {
    const newVal = !pushNotifications;
    setPushNotifications(newVal);
    if (userId) {
      notificationService.updatePreferences(userId, {
        ride_updates: newVal,
        chat_messages: newVal,
        payment_updates: newVal,
      }).catch(() => setPushNotifications(!newVal));
    }
  }

  async function handleToggleEmail() {
    const newVal = !emailNotifications;
    setEmailNotifications(newVal);
    if (userId) {
      notificationService.updatePreferences(userId, { promotions: newVal }).catch(() => setEmailNotifications(!newVal));
    }
  }

  async function handleToggleSms() {
    const newVal = !smsNotifications;
    setSmsNotifications(newVal);
    if (userId) {
      notificationService.updateSmsPreference(userId, newVal).catch(() => setSmsNotifications(!newVal));
    }
  }

  function handleLanguageChange(code: string) {
    setLanguage(code);
    i18n.changeLanguage(code);
    localStorage.setItem('tricigo_language', code);
    document.documentElement.lang = code;
  }

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
        <p style={{ color: 'var(--text-secondary)' }}>{t('web.login_required', { defaultValue: 'Inicia sesion para ver la configuracion' })}</p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          {t('web.login', { defaultValue: 'Iniciar sesion' })}
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
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{t('web.settings', { defaultValue: 'Configuracion' })}</h1>
      </div>

      {/* Language Section */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          {t('web.language', { defaultValue: 'Idioma' })}
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

      {/* Appearance */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          {t('web.appearance', { defaultValue: 'Apariencia' })}
        </h2>
        <div style={{ background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', overflow: 'hidden', display: 'flex' }}>
          {(['light', 'dark', 'system'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                setDarkMode(mode);
                localStorage.setItem('tricigo_theme', mode);
                // Apply theme
                if (mode === 'system') {
                  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                  document.documentElement.classList.toggle('dark', prefersDark);
                } else {
                  document.documentElement.classList.toggle('dark', mode === 'dark');
                }
              }}
              style={{
                flex: 1,
                padding: '0.875rem 0.5rem',
                background: darkMode === mode ? 'var(--primary)' : 'transparent',
                color: darkMode === mode ? 'white' : 'var(--text-primary)',
                border: 'none',
                cursor: 'pointer',
                fontWeight: darkMode === mode ? 600 : 400,
                fontSize: '0.875rem',
                transition: 'all 0.2s',
              }}
            >
              {mode === 'light' ? '☀️ ' + t('web.theme_light', { defaultValue: 'Claro' }) :
               mode === 'dark' ? '🌙 ' + t('web.theme_dark', { defaultValue: 'Oscuro' }) :
               '📱 ' + t('web.theme_system', { defaultValue: 'Sistema' })}
            </button>
          ))}
        </div>
      </div>

      {/* Notification Preferences */}
      <div>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          {t('web.notifications', { defaultValue: 'Notificaciones' })}
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
              <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>{t('web.push_notifications', { defaultValue: 'Notificaciones push' })}</p>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>{t('web.realtime_alerts', { defaultValue: 'Alertas en tiempo real' })}</p>
            </div>
            <button onClick={handleTogglePush} disabled={prefsLoading} style={toggleStyle(pushNotifications)}>
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
              <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>{t('web.email_notifications', { defaultValue: 'Correo electronico' })}</p>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>{t('web.receipts_promos', { defaultValue: 'Recibos y promociones' })}</p>
            </div>
            <button onClick={handleToggleEmail} disabled={prefsLoading} style={toggleStyle(emailNotifications)}>
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
              <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>{t('web.sms', { defaultValue: 'SMS' })}</p>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>{t('web.sms_updates', { defaultValue: 'Actualizaciones por mensaje de texto' })}</p>
            </div>
            <button onClick={handleToggleSms} disabled={prefsLoading} style={toggleStyle(smsNotifications)}>
              <div style={toggleKnobStyle(smsNotifications)} />
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
