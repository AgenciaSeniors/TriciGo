'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { customerService, getSupabaseClient, useFeatureFlag } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { RidePreferences, AccessibilityNeed } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

// Mirror of the mobile screen (apps/client/app/profile/ride-preferences.tsx):
// same fields, same persistence (customer_profiles.ride_preferences via
// customerService.ensureProfile/updateProfile) and the same debounced
// save-on-toggle behavior. /book reads these saved preferences and sends them
// as rider_preferences on createRide — identical to the mobile flow.

type TemperaturePref = 'cool' | 'warm' | 'no_preference';

const ACCESSIBILITY_OPTIONS: { value: AccessibilityNeed; labelKey: string; labelDefault: string; descKey: string; descDefault: string; icon: string }[] = [
  { value: 'wheelchair', labelKey: 'preferences.a11y_wheelchair', labelDefault: 'Silla de ruedas', descKey: 'preferences.a11y_wheelchair_desc', descDefault: 'Necesito asistencia con silla de ruedas', icon: '♿' },
  { value: 'hearing_impaired', labelKey: 'preferences.a11y_hearing', labelDefault: 'Discapacidad auditiva', descKey: 'preferences.a11y_hearing_desc', descDefault: 'Tengo dificultad auditiva', icon: '🦻' },
  { value: 'visual_impaired', labelKey: 'preferences.a11y_visual', labelDefault: 'Discapacidad visual', descKey: 'preferences.a11y_visual_desc', descDefault: 'Tengo dificultad visual', icon: '🦯' },
  { value: 'service_animal', labelKey: 'preferences.a11y_service_animal', labelDefault: 'Animal de servicio', descKey: 'preferences.a11y_service_animal_desc', descDefault: 'Viajo con un animal de servicio', icon: '🐕' },
  { value: 'extra_space', labelKey: 'preferences.a11y_extra_space', labelDefault: 'Espacio extra', descKey: 'preferences.a11y_extra_space_desc', descDefault: 'Necesito espacio adicional', icon: '↔️' },
];

const TEMP_OPTIONS: { value: TemperaturePref; labelKey: string; labelDefault: string; icon: string }[] = [
  { value: 'cool', labelKey: 'preferences.temp_cool', labelDefault: 'Fresco', icon: '❄️' },
  { value: 'warm', labelKey: 'preferences.temp_warm', labelDefault: 'Cálido', icon: '☀️' },
  { value: 'no_preference', labelKey: 'preferences.temp_no_preference', labelDefault: 'Sin pref.', icon: '—' },
];

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)', borderRadius: '1rem',
  border: '1px solid var(--border-light)', padding: '1.1rem 1.25rem',
};

function Toggle({ on }: { on: boolean }) {
  return (
    <div aria-hidden="true" style={{ width: 40, height: 22, borderRadius: 11, position: 'relative', flexShrink: 0, background: on ? 'var(--primary)' : 'var(--border)', transition: 'background 0.2s' }}>
      <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: on ? 20 : 2, transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
    </div>
  );
}

export default function RidePreferencesPage() {
  // Same namespace + keys as the mobile screen (common.json → preferences.*).
  const { t } = useTranslation('common');
  const router = useRouter();
  const enabled = useFeatureFlag('ride_preferences_enabled');

  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [profileId, setProfileId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<RidePreferences>({});
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedBadgeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!userId) { return; }
    customerService.ensureProfile(userId).then((profile) => {
      setProfileId(profile.id);
      setPrefs(profile.ride_preferences ?? {});
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [userId]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      if (savedBadgeTimeoutRef.current) clearTimeout(savedBadgeTimeoutRef.current);
    };
  }, []);

  const savePrefs = useCallback((updated: RidePreferences) => {
    setPrefs(updated);
    if (!profileId) return;

    // Debounce the actual API save to prevent concurrent saves on rapid
    // toggles (same 500ms window as the mobile screen).
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    if (savedBadgeTimeoutRef.current) clearTimeout(savedBadgeTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      setSaveState('saving');
      try {
        await customerService.updateProfile(profileId, { ride_preferences: updated });
        setSaveState('saved');
        savedBadgeTimeoutRef.current = setTimeout(() => setSaveState('idle'), 2000);
      } catch {
        setSaveState('error');
      }
    }, 500);
  }, [profileId]);

  const toggleQuietMode = useCallback(() => {
    savePrefs({ ...prefs, quiet_mode: !prefs.quiet_mode });
  }, [prefs, savePrefs]);

  const toggleConversation = useCallback(() => {
    savePrefs({ ...prefs, conversation_ok: !prefs.conversation_ok });
  }, [prefs, savePrefs]);

  const toggleLuggage = useCallback(() => {
    savePrefs({ ...prefs, luggage_trunk: !prefs.luggage_trunk });
  }, [prefs, savePrefs]);

  const toggleAccessibility = useCallback((need: AccessibilityNeed) => {
    const current = prefs.accessibility_needs ?? [];
    const updated = current.includes(need)
      ? current.filter((n) => n !== need)
      : [...current, need];
    savePrefs({ ...prefs, accessibility_needs: updated });
  }, [prefs, savePrefs]);

  const setTemperature = useCallback((temp: TemperaturePref) => {
    savePrefs({ ...prefs, temperature: temp });
  }, [prefs, savePrefs]);

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>{t('loading', { defaultValue: 'Cargando...' })}</p>
      </div>
    );
  }

  if (!userId) {
    router.replace('/login');
    return null;
  }

  const switchRow = (icon: string, label: string, desc: string, value: boolean, onToggle: () => void) => (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={value}
      style={{ ...cardStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', width: '100%', textAlign: 'left', cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1 }}>
        <span aria-hidden="true" style={{ fontSize: '1.25rem' }}>{icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.4 }}>{desc}</div>
        </div>
      </div>
      <Toggle on={value} />
    </button>
  );

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.75rem' }}>
        <Link href="/profile" aria-label={t('web.back_to_profile', { defaultValue: 'Volver al perfil' })} style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, flex: 1 }}>
          {t('preferences.title', { defaultValue: 'Preferencias de viaje' })}
        </h1>
        {/* Save status (loading/saving/saved like the mobile header spinner) */}
        <span aria-live="polite" style={{ fontSize: '0.78rem', fontWeight: 600, color: saveState === 'error' ? '#dc2626' : saveState === 'saved' ? '#16a34a' : 'var(--text-tertiary)' }}>
          {saveState === 'saving' && t('web.saving', { defaultValue: 'Guardando...' })}
          {saveState === 'saved' && t('preferences.saved', { defaultValue: 'Preferencias guardadas' })}
          {saveState === 'error' && t('errors.preferences_save_failed', { defaultValue: 'Error al guardar preferencias' })}
        </span>
      </div>

      <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1.5rem', lineHeight: 1.5 }}>
        {t('web.ride_preferences_desc', { defaultValue: 'El conductor verá tus preferencias al aceptar tu viaje.' })}
      </p>

      {!enabled ? (
        <WebEmptyState
          icon={'🎚️'}
          title={t('coming_soon', { defaultValue: 'Próximamente' })}
          description={t('web.ride_preferences_coming_soon_desc', { defaultValue: 'Las preferencias de viaje estarán disponibles muy pronto.' })}
        />
      ) : loading ? (
        <WebSkeletonList count={4} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {/* Quiet Mode */}
          {switchRow(
            '🔇',
            t('preferences.quiet_mode', { defaultValue: 'Modo silencio' }),
            t('preferences.quiet_mode_desc', { defaultValue: 'Prefiero un viaje tranquilo sin conversación' }),
            !!prefs.quiet_mode,
            toggleQuietMode,
          )}

          {/* Temperature */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <span aria-hidden="true" style={{ fontSize: '1.25rem' }}>{'🌡️'}</span>
              <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                {t('preferences.temperature', { defaultValue: 'Temperatura' })}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {TEMP_OPTIONS.map((opt) => {
                const selected = (prefs.temperature ?? 'no_preference') === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setTemperature(opt.value)}
                    aria-pressed={selected}
                    style={{
                      flex: 1, padding: '0.6rem 0.5rem', borderRadius: '0.75rem',
                      fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
                      border: selected ? '1.5px solid var(--primary)' : '1px solid var(--border)',
                      background: selected ? 'rgba(255,77,0,0.08)' : 'transparent',
                      color: selected ? 'var(--primary)' : 'var(--text-secondary)',
                    }}
                  >
                    {opt.icon} {t(opt.labelKey, { defaultValue: opt.labelDefault })}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Conversation OK */}
          {switchRow(
            '💬',
            t('preferences.conversation_ok', { defaultValue: 'Conversación bienvenida' }),
            t('preferences.conversation_ok_desc', { defaultValue: 'Me gusta conversar durante el viaje' }),
            !!prefs.conversation_ok,
            toggleConversation,
          )}

          {/* Luggage / Trunk */}
          {switchRow(
            '🧳',
            t('preferences.luggage_trunk', { defaultValue: 'Espacio para equipaje' }),
            t('preferences.luggage_trunk_desc', { defaultValue: 'Necesito espacio para maletas o paquetes' }),
            !!prefs.luggage_trunk,
            toggleLuggage,
          )}

          {/* Accessibility Needs */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <span aria-hidden="true" style={{ fontSize: '1.25rem' }}>{'♿'}</span>
              <div>
                <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {t('preferences.accessibility_title', { defaultValue: 'Necesidades de accesibilidad' })}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.4 }}>
                  {t('preferences.accessibility_desc', { defaultValue: 'Informa al conductor sobre tus necesidades especiales' })}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {ACCESSIBILITY_OPTIONS.map((opt) => {
                const selected = (prefs.accessibility_needs ?? []).includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggleAccessibility(opt.value)}
                    aria-pressed={selected}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%',
                      padding: '0.7rem 0.75rem', borderRadius: '0.75rem', textAlign: 'left', cursor: 'pointer',
                      border: selected ? '1.5px solid var(--primary)' : '1px solid var(--border)',
                      background: selected ? 'rgba(255,77,0,0.08)' : 'transparent',
                    }}
                  >
                    <span aria-hidden="true" style={{ fontSize: '1.1rem' }}>{opt.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '0.88rem', fontWeight: 600, color: selected ? 'var(--primary)' : 'var(--text-primary)' }}>
                        {t(opt.labelKey, { defaultValue: opt.labelDefault })}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: 1 }}>
                        {t(opt.descKey, { defaultValue: opt.descDefault })}
                      </div>
                    </div>
                    <span aria-hidden="true" style={{ fontSize: '1rem', color: selected ? 'var(--primary)' : 'var(--border)' }}>
                      {selected ? '✓' : '○'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
