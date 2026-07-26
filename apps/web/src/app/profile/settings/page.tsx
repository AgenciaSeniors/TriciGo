'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getSupabaseClient, notificationService, customerService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { CustomerProfile, PaymentMethod } from '@tricigo/types';

const languages = [
  { code: 'es', label: 'Espanol' },
  { code: 'en', label: 'English' },
  { code: 'pt', label: 'Portugues' },
];

const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'tricicoin', 'mixed'];

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
  const [customerProfile, setCustomerProfile] = useState<CustomerProfile | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');

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
    // Same storage key the header toggle uses ('tricigo-theme'); the page
    // previously read/wrote 'tricigo_theme' — a key nothing else honored.
    const savedTheme = localStorage.getItem('tricigo-theme') as 'light' | 'dark' | null;
    setDarkMode(savedTheme ?? 'system');
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
        // The web exposes ONE coarse "push" switch over three columns
        // that `handleTogglePush` writes together. It used to read back
        // only `ride_updates`, so a user who disabled just chat or
        // payments in the mobile app saw this switch ON — and toggling
        // it would then overwrite all three. Deriving it from all three
        // means "on" honestly means "all push categories on"; anything
        // partial reads as off, and turning it on re-enables the set.
        // Per-category control stays in the mobile app.
        setPushNotifications(
          prefs.ride_updates && prefs.chat_messages && prefs.payment_updates,
        );
        setEmailNotifications(prefs.promotions);
      }
      setSmsNotifications(sms);
    }).catch(() => {}).finally(() => setPrefsLoading(false));
  }, [userId]);

  // Load the customer profile — the default payment method lives there
  // (not on the auth user), parity con el settings móvil.
  useEffect(() => {
    if (!userId) return;
    customerService.ensureProfile(userId).then((cp) => {
      setCustomerProfile(cp);
      setPaymentMethod(cp.default_payment_method);
    }).catch(() => {});
  }, [userId]);

  async function handleSelectPayment(method: PaymentMethod) {
    if (!customerProfile || method === paymentMethod) return;
    const prev = paymentMethod;
    setPaymentMethod(method); // optimistic
    try {
      await customerService.updateProfile(customerProfile.id, { default_payment_method: method });
    } catch {
      setPaymentMethod(prev); // revert on failure
    }
  }

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
    // Persist to public.users so the language syncs across devices (parity con
    // el users.preferred_language del settings móvil). Best-effort.
    if (userId) {
      void getSupabaseClient().from('users').update({ preferred_language: code }).eq('id', userId).then(() => {}, () => {});
    }
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
        <Link href="/profile" aria-label={t('back', { defaultValue: 'Volver' })} style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

      {/* Default payment method (parity con el selector del settings móvil —
          vive en customer_profiles.default_payment_method, no en el auth user). */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          {t('web.payment_method', { defaultValue: 'Método de pago' })}
        </h2>
        <div style={{ background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', overflow: 'hidden', display: 'flex' }}>
          {PAYMENT_METHODS.map((method) => {
            const on = paymentMethod === method;
            const label = method === 'cash'
              ? t('web.payment_cash', { defaultValue: 'Efectivo' })
              : method === 'tricicoin'
                ? t('web.payment_tricicoin', { defaultValue: 'TriciCoin' })
                : t('web.payment_mixed', { defaultValue: 'Mixto' });
            return (
              <button
                key={method}
                onClick={() => handleSelectPayment(method)}
                disabled={!customerProfile}
                style={{
                  flex: 1, padding: '0.875rem 0.5rem',
                  background: on ? 'var(--primary)' : 'transparent',
                  color: on ? '#fff' : 'var(--text-primary)',
                  border: 'none', cursor: customerProfile ? 'pointer' : 'not-allowed',
                  fontWeight: on ? 600 : 400, fontSize: '0.875rem', transition: 'all 0.2s',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', margin: '0.5rem 0 0' }}>
          {t('web.payment_method_hint', { defaultValue: 'Se usará por defecto al pedir un viaje.' })}
        </p>
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
                // The web theme is driven by [data-theme] on <html> (globals.css)
                // + the 'tricigo-theme' key the header reads. The old handler
                // toggled a `.dark` CLASS no stylesheet used and persisted to a
                // different key — the selector highlighted but nothing changed.
                if (mode === 'system') {
                  localStorage.removeItem('tricigo-theme');
                  // No attribute → globals.css falls back to prefers-color-scheme.
                  document.documentElement.removeAttribute('data-theme');
                } else {
                  localStorage.setItem('tricigo-theme', mode);
                  document.documentElement.setAttribute('data-theme', mode);
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
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
                {mode === 'light' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                ) : mode === 'dark' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
                )}
                {mode === 'light' ? t('web.theme_light', { defaultValue: 'Claro' }) :
                 mode === 'dark' ? t('web.theme_dark', { defaultValue: 'Oscuro' }) :
                 t('web.theme_system', { defaultValue: 'Sistema' })}
              </span>
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

      {/* Danger zone — eliminar cuenta (parity con el settings móvil). La
          página /account/delete ya existía pero no estaba enlazada desde aquí. */}
      <div style={{ marginTop: '2rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--error, #dc2626)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          {t('web.account', { defaultValue: 'Cuenta' })}
        </h2>
        <Link
          href="/account/delete"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem', background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid rgba(239,68,68,0.3)', textDecoration: 'none', color: 'var(--error, #dc2626)', fontSize: '0.95rem', fontWeight: 600 }}
        >
          {t('web.delete_account', { defaultValue: 'Eliminar mi cuenta' })}
          <span aria-hidden="true">›</span>
        </Link>
      </div>
    </main>
  );
}
