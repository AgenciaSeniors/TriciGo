'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseClient, customerService } from '@tricigo/api';

type TemperaturePref = 'cool' | 'warm' | 'no_preference';
type AccessibilityNeed = 'wheelchair' | 'hearing_impaired' | 'visual_impaired' | 'service_animal' | 'extra_space';

interface RidePreferences {
  quiet_mode?: boolean;
  conversation_ok?: boolean;
  temperature?: TemperaturePref;
  luggage_trunk?: boolean;
  accessibility_needs?: AccessibilityNeed[];
}

const TEMP_OPTIONS: { value: TemperaturePref; label: string }[] = [
  { value: 'cool', label: 'Frio' },
  { value: 'warm', label: 'Calido' },
  { value: 'no_preference', label: 'Sin preferencia' },
];

const ACCESSIBILITY_OPTIONS: { value: AccessibilityNeed; label: string; desc: string }[] = [
  { value: 'wheelchair', label: 'Silla de ruedas', desc: 'Necesito un vehiculo accesible para silla de ruedas' },
  { value: 'hearing_impaired', label: 'Discapacidad auditiva', desc: 'Tengo discapacidad auditiva' },
  { value: 'visual_impaired', label: 'Discapacidad visual', desc: 'Tengo discapacidad visual' },
  { value: 'service_animal', label: 'Animal de servicio', desc: 'Viajo con un animal de servicio' },
  { value: 'extra_space', label: 'Espacio extra', desc: 'Necesito espacio adicional' },
];

export default function RidePreferencesPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<RidePreferences>({});

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!userId) return;
    customerService.ensureProfile(userId).then((profile) => {
      setProfileId(profile.id);
      setPrefs(profile.ride_preferences ?? {});
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [userId]);

  const savePrefs = useCallback(async (updated: RidePreferences) => {
    setPrefs(updated);
    if (!profileId) return;
    setSaving(true);
    try {
      await customerService.updateProfile(profileId, { ride_preferences: updated });
    } catch (err) {
      console.error('Error saving preferences:', err);
      alert('Error al guardar preferencias. Intenta de nuevo.');
    } finally {
      setSaving(false);
    }
  }, [profileId]);

  const togglePref = (key: 'quiet_mode' | 'conversation_ok' | 'luggage_trunk') => {
    savePrefs({ ...prefs, [key]: !prefs[key] });
  };

  const setTemperature = (temp: TemperaturePref) => {
    savePrefs({ ...prefs, temperature: temp });
  };

  const toggleAccessibility = (need: AccessibilityNeed) => {
    const current = prefs.accessibility_needs ?? [];
    const updated = current.includes(need) ? current.filter((n) => n !== need) : [...current, need];
    savePrefs({ ...prefs, accessibility_needs: updated });
  };

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

  const toggleStyle = (active: boolean): React.CSSProperties => ({
    position: 'relative', display: 'inline-block', width: 44, height: 24, flexShrink: 0, cursor: 'pointer',
  });

  const toggleTrack = (active: boolean): React.CSSProperties => ({
    position: 'absolute', cursor: 'pointer', inset: 0, borderRadius: 24,
    background: active ? 'var(--primary)' : '#ccc', transition: 'background 0.2s',
  });

  const toggleThumb = (active: boolean): React.CSSProperties => ({
    position: 'absolute', height: 18, width: 18, left: active ? 22 : 3, bottom: 3,
    background: '#fff', borderRadius: '50%', transition: 'left 0.2s',
  });

  const renderToggle = (key: 'quiet_mode' | 'conversation_ok' | 'luggage_trunk', label: string, desc: string) => (
    <div style={{
      background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', padding: '1.25rem',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem',
    }}>
      <div style={{ flex: 1 }}>
        <p style={{ margin: 0, fontWeight: 500, fontSize: '0.95rem', color: 'var(--text-primary)' }}>{label}</p>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{desc}</p>
      </div>
      <label style={toggleStyle(!!prefs[key])}>
        <input type="checkbox" checked={!!prefs[key]} onChange={() => togglePref(key)} style={{ opacity: 0, width: 0, height: 0 }} />
        <span style={toggleTrack(!!prefs[key])}>
          <span style={toggleThumb(!!prefs[key])} />
        </span>
      </label>
    </div>
  );

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, flex: 1 }}>Preferencias de viaje</h1>
        {saving && <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Guardando...</span>}
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-tertiary)', textAlign: 'center', padding: '2rem 0' }}>Cargando preferencias...</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {renderToggle('quiet_mode', 'Modo silencioso', 'Prefiero un viaje en silencio')}
          {renderToggle('conversation_ok', 'Conversacion OK', 'Estoy abierto a conversar con el conductor')}
          {renderToggle('luggage_trunk', 'Equipaje en maletero', 'Necesito usar el maletero para equipaje')}

          {/* Temperature */}
          <div style={{
            background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', padding: '1.25rem',
          }}>
            <p style={{ margin: '0 0 0.75rem', fontWeight: 500, fontSize: '0.95rem', color: 'var(--text-primary)' }}>Temperatura</p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {TEMP_OPTIONS.map((opt) => {
                const selected = (prefs.temperature ?? 'no_preference') === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setTemperature(opt.value)}
                    style={{
                      flex: 1, padding: '0.6rem 0.5rem', borderRadius: '0.75rem', fontSize: '0.85rem', fontWeight: 500,
                      border: selected ? '2px solid var(--primary)' : '1px solid var(--border)',
                      background: selected ? 'rgba(0,0,0,0.02)' : 'transparent',
                      color: selected ? 'var(--primary)' : 'var(--text-secondary)',
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Accessibility */}
          <div style={{
            background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', padding: '1.25rem',
          }}>
            <p style={{ margin: '0 0 0.25rem', fontWeight: 500, fontSize: '0.95rem', color: 'var(--text-primary)' }}>Accesibilidad</p>
            <p style={{ margin: '0 0 1rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Selecciona las necesidades que apliquen</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {ACCESSIBILITY_OPTIONS.map((opt) => {
                const selected = (prefs.accessibility_needs ?? []).includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    onClick={() => toggleAccessibility(opt.value)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem',
                      borderRadius: '0.75rem', border: selected ? '2px solid var(--primary)' : '1px solid var(--border)',
                      background: selected ? 'rgba(0,0,0,0.02)' : 'transparent',
                      cursor: 'pointer', textAlign: 'left',
                    }}
                  >
                    <div style={{
                      width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                      border: selected ? 'none' : '2px solid var(--border)',
                      background: selected ? 'var(--primary)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {selected && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ margin: 0, fontSize: '0.9rem', fontWeight: 500, color: selected ? 'var(--primary)' : 'var(--text-primary)' }}>{opt.label}</p>
                      <p style={{ margin: '0.15rem 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{opt.desc}</p>
                    </div>
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
