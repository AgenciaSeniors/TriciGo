'use client';

/**
 * Ride preferences (web) — parity con apps/client/app/profile/ride-preferences.
 * Persists default rider preferences on the customer profile
 * (customerService.updateProfile → customer_profiles.ride_preferences),
 * debounced like the native screen.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { customerService } from '@tricigo/api';
import type { RidePreferences, AccessibilityNeed } from '@tricigo/types';
import { useTranslation } from '@tricigo/i18n';
import { useAuth } from '../../providers';

type TemperaturePref = 'cool' | 'warm' | 'no_preference';

const TEMP_OPTIONS: { value: TemperaturePref; label: string; icon: string }[] = [
  { value: 'cool', label: 'Fresco', icon: '❄️' },
  { value: 'warm', label: 'Cálido', icon: '☀️' },
  { value: 'no_preference', label: 'Sin preferencia', icon: '—' },
];

const A11Y_OPTIONS: { value: AccessibilityNeed; label: string; desc: string; icon: string }[] = [
  { value: 'wheelchair', label: 'Silla de ruedas', desc: 'Necesito espacio para silla de ruedas', icon: '♿' },
  { value: 'hearing_impaired', label: 'Sordo / hipoacúsico', desc: 'Prefiero comunicación por texto', icon: '🦻' },
  { value: 'visual_impaired', label: 'Baja visión', desc: 'Necesito asistencia visual', icon: '🕶️' },
  { value: 'service_animal', label: 'Animal de servicio', desc: 'Viajo con un animal de servicio', icon: '🐕' },
  { value: 'extra_space', label: 'Espacio extra', desc: 'Necesito espacio adicional', icon: '↔️' },
];

export default function RidePreferencesPage() {
  const router = useRouter();
  const { t } = useTranslation('common');
  const { user, isLoading: authLoading, isAuthenticated } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<RidePreferences>({});
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.replace('/login');
  }, [authLoading, isAuthenticated, router]);

  useEffect(() => {
    if (!user?.id) return;
    customerService.ensureProfile(user.id).then((profile) => {
      setProfileId(profile.id);
      setPrefs(profile.ride_preferences ?? {});
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [user?.id]);

  useEffect(() => () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); }, []);

  const savePrefs = useCallback((updated: RidePreferences) => {
    setPrefs(updated);
    if (!profileId) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await customerService.updateProfile(profileId, { ride_preferences: updated });
      } catch { /* best-effort */ } finally {
        setSaving(false);
      }
    }, 500);
  }, [profileId]);

  const toggleA11y = (need: AccessibilityNeed) => {
    const current = prefs.accessibility_needs ?? [];
    savePrefs({ ...prefs, accessibility_needs: current.includes(need) ? current.filter((n) => n !== need) : [...current, need] });
  };

  const card: React.CSSProperties = { padding: '1rem', borderRadius: '0.85rem', border: '1px solid var(--border)', background: 'var(--bg-card)' };
  const Switch = ({ on, onClick }: { on: boolean; onClick: () => void }) => (
    <button type="button" onClick={onClick} aria-pressed={on} style={{ width: 44, height: 24, borderRadius: 12, position: 'relative', flexShrink: 0, border: 'none', cursor: 'pointer', background: on ? 'var(--primary)' : 'var(--border)', transition: 'background 0.2s' }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 22 : 2, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
    </button>
  );

  return (
    <main className="page-main">
      <div className="page-container" style={{ maxWidth: 560 }}>
        <Link href="/profile" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>&larr; {t('back', { defaultValue: 'Volver' })}</Link>
        <h1 style={{ fontSize: 'clamp(1.4rem,4vw,1.9rem)', fontWeight: 800, margin: '1rem 0 0.25rem' }}>
          {t('preferences.title', { defaultValue: 'Preferencias de viaje' })}
        </h1>
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
          {saving ? t('saving', { defaultValue: 'Guardando…' }) : t('preferences.subtitle', { defaultValue: 'Se aplican por defecto a tus próximos viajes.' })}
        </p>

        {loading ? (
          <p style={{ color: 'var(--text-tertiary)' }}>{t('loading', { defaultValue: 'Cargando…' })}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            {/* Quiet mode */}
            <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
              <div>
                <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>🔇 {t('preferences.quiet_mode', { defaultValue: 'Modo silencio' })}</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', marginTop: 2 }}>{t('preferences.quiet_mode_desc', { defaultValue: 'Prefiero un viaje tranquilo.' })}</div>
              </div>
              <Switch on={!!prefs.quiet_mode} onClick={() => savePrefs({ ...prefs, quiet_mode: !prefs.quiet_mode })} />
            </div>

            {/* Temperature */}
            <div style={card}>
              <div style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.6rem' }}>🌡️ {t('preferences.temperature', { defaultValue: 'Temperatura' })}</div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {TEMP_OPTIONS.map((opt) => {
                  const selected = (prefs.temperature ?? 'no_preference') === opt.value;
                  return (
                    <button key={opt.value} type="button" onClick={() => savePrefs({ ...prefs, temperature: opt.value })}
                      style={{ flex: 1, padding: '0.55rem', borderRadius: '0.6rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
                        border: selected ? '2px solid var(--primary)' : '1px solid var(--border)',
                        background: selected ? 'rgba(255,77,0,0.08)' : 'var(--bg-page)',
                        color: selected ? 'var(--primary)' : 'var(--text-secondary)' }}>
                      {opt.icon} {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Conversation */}
            <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
              <div>
                <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>💬 {t('preferences.conversation_ok', { defaultValue: 'Conversación' })}</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', marginTop: 2 }}>{t('preferences.conversation_ok_desc', { defaultValue: 'Me gusta conversar durante el viaje.' })}</div>
              </div>
              <Switch on={!!prefs.conversation_ok} onClick={() => savePrefs({ ...prefs, conversation_ok: !prefs.conversation_ok })} />
            </div>

            {/* Luggage */}
            <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
              <div>
                <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>🧳 {t('preferences.luggage_trunk', { defaultValue: 'Maletero' })}</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', marginTop: 2 }}>{t('preferences.luggage_trunk_desc', { defaultValue: 'Suelo llevar equipaje.' })}</div>
              </div>
              <Switch on={!!prefs.luggage_trunk} onClick={() => savePrefs({ ...prefs, luggage_trunk: !prefs.luggage_trunk })} />
            </div>

            {/* Accessibility */}
            <div style={card}>
              <div style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.6rem' }}>♿ {t('preferences.accessibility_title', { defaultValue: 'Accesibilidad' })}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {A11Y_OPTIONS.map((opt) => {
                  const selected = (prefs.accessibility_needs ?? []).includes(opt.value);
                  return (
                    <button key={opt.value} type="button" onClick={() => toggleA11y(opt.value)}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.75rem', borderRadius: '0.6rem', cursor: 'pointer', textAlign: 'left',
                        border: selected ? '2px solid var(--primary)' : '1px solid var(--border)',
                        background: selected ? 'rgba(255,77,0,0.06)' : 'var(--bg-page)' }}>
                      <span style={{ fontSize: '1.1rem' }}>{opt.icon}</span>
                      <span style={{ flex: 1 }}>
                        <span style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: selected ? 'var(--primary)' : 'var(--text-primary)' }}>{opt.label}</span>
                        <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>{opt.desc}</span>
                      </span>
                      <span aria-hidden style={{ color: selected ? 'var(--primary)' : 'var(--text-tertiary)' }}>{selected ? '✓' : '○'}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
