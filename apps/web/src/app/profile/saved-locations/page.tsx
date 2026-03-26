'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { getSupabaseClient, customerService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { AddressAutocomplete } from '@/components/AddressAutocomplete';

interface SavedLocation {
  label: string;
  address: string;
  latitude: number;
  longitude: number;
}

export default function SavedLocationsPage() {
  const { t } = useTranslation();
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [locations, setLocations] = useState<SavedLocation[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [formLabel, setFormLabel] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formLat, setFormLat] = useState(0);
  const [formLng, setFormLng] = useState(0);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
  }, []);

  const loadLocations = useCallback(async () => {
    if (!userId) return;
    try {
      const profile = await customerService.ensureProfile(userId);
      setProfileId(profile.id);
      setLocations(profile.saved_locations ?? []);
    } catch (err) {
      console.error('Error loading saved locations:', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) loadLocations();
  }, [userId, loadLocations]);

  async function handleSave() {
    if (!profileId || !formLabel.trim() || !formAddress.trim()) return;
    const newLoc: SavedLocation = {
      label: formLabel.trim(),
      address: formAddress.trim(),
      latitude: formLat,
      longitude: formLng,
    };

    let updated: SavedLocation[];
    if (editingIndex !== null) {
      updated = locations.map((loc, i) => (i === editingIndex ? newLoc : loc));
    } else {
      updated = [...locations, newLoc];
    }

    try {
      await customerService.updateProfile(profileId, { saved_locations: updated });
      setLocations(updated);
      setShowForm(false);
      setEditingIndex(null);
      setFormLabel('');
      setFormAddress('');
      setFormLat(0);
      setFormLng(0);
    } catch (err) {
      console.error('Error saving location:', err);
      alert(t('web.save_location_error', { defaultValue: 'Error al guardar ubicacion. Intenta de nuevo.' }));
    }
  }

  async function handleDelete(index: number) {
    if (!profileId) return;
    if (!confirm(t('web.delete_location_confirm', { defaultValue: 'Eliminar ubicacion?' }))) return;
    const updated = locations.filter((_, i) => i !== index);
    try {
      await customerService.updateProfile(profileId, { saved_locations: updated });
      setLocations(updated);
    } catch (err) {
      console.error('Error deleting location:', err);
      alert(t('web.delete_location_error', { defaultValue: 'Error al eliminar ubicacion.' }));
    }
  }

  function handleEdit(index: number) {
    const loc = locations[index];
    setEditingIndex(index);
    setFormLabel(loc.label);
    setFormAddress(loc.address);
    setFormLat(loc.latitude);
    setFormLng(loc.longitude);
    setShowForm(true);
  }

  function handleAddNew() {
    setEditingIndex(null);
    setFormLabel('');
    setFormAddress('');
    setFormLat(0);
    setFormLng(0);
    setShowForm(true);
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
        <p style={{ color: 'var(--text-secondary)' }}>{t('web.login_required_locations', { defaultValue: 'Inicia sesion para ver tus ubicaciones' })}</p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          {t('web.login', { defaultValue: 'Iniciar sesion' })}
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

  const DeleteIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  );

  const getIcon = (label: string) => {
    const lower = label.toLowerCase();
    if (lower === 'casa' || lower === 'home') {
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      );
    }
    if (lower === 'trabajo' || lower === 'work') {
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
          <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
        </svg>
      );
    }
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f6ad55" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    );
  };

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem', background: 'var(--bg-card)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{t('web.saved_locations', { defaultValue: 'Ubicaciones guardadas' })}</h1>
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-tertiary)', textAlign: 'center', padding: '2rem 0' }}>{t('web.loading_locations', { defaultValue: 'Cargando ubicaciones...' })}</p>
      ) : locations.length === 0 && !showForm ? (
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: '1rem',
          border: '1px solid var(--border-light)',
          padding: '2rem 1.25rem',
          textAlign: 'center',
          marginBottom: '1.5rem',
        }}>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-tertiary)', margin: '0 0 0.5rem' }}>
            {t('web.no_saved_locations', { defaultValue: 'No tienes ubicaciones guardadas aun.' })}
          </p>
        </div>
      ) : (
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: '1rem',
          border: '1px solid var(--border-light)',
          overflow: 'hidden',
          marginBottom: '1.5rem',
        }}>
          {locations.map((loc, index) => (
            <div
              key={index}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '1rem 1.25rem',
                borderBottom: index < locations.length - 1 ? '1px solid var(--border-light)' : 'none',
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
                {getIcon(loc.label)}
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>{loc.label}</p>
                <p style={{ margin: '0.2rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                  {loc.address || t('web.no_address', { defaultValue: 'Sin direccion' })}
                </p>
              </div>
              <button onClick={() => handleEdit(index)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.5rem' }}>
                <EditIcon />
              </button>
              <button onClick={() => handleDelete(index)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.5rem' }}>
                <DeleteIcon />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit Form */}
      {showForm && (
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: '1rem',
          border: '1px solid var(--border-light)',
          padding: '1.5rem',
          marginBottom: '1.5rem',
        }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 1rem' }}>
            {editingIndex !== null ? t('web.edit_location', { defaultValue: 'Editar ubicacion' }) : t('web.new_location', { defaultValue: 'Nueva ubicacion' })}
          </h3>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>{t('web.name', { defaultValue: 'Nombre' })}</label>
            <input
              type="text" value={formLabel} onChange={(e) => setFormLabel(e.target.value)}
              placeholder={t('web.location_placeholder', { defaultValue: 'Casa, Trabajo, Gym...' })}
              style={{
                width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
                fontSize: '0.95rem', background: 'var(--bg-page)', color: 'var(--text-primary)', boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: '1.25rem' }}>
            <AddressAutocomplete
              label={t('web.address', { defaultValue: 'Direccion' })}
              placeholder="Buscar dirección..."
              value={formAddress}
              mapboxToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN || ''}
              onSelect={(r) => {
                setFormAddress(r.address);
                setFormLat(r.latitude);
                setFormLng(r.longitude);
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              onClick={() => { setShowForm(false); setEditingIndex(null); setFormLabel(''); setFormAddress(''); setFormLat(0); setFormLng(0); }}
              style={{
                flex: 1, padding: '0.75rem', background: 'transparent', color: 'var(--text-secondary)',
                border: '1px solid var(--border)', borderRadius: '0.5rem', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer',
              }}
            >
              {t('common.cancel', { defaultValue: 'Cancelar' })}
            </button>
            <button
              onClick={handleSave}
              disabled={!formLabel.trim() || !formAddress.trim()}
              style={{
                flex: 1, padding: '0.75rem', background: 'var(--primary)', color: '#fff',
                border: 'none', borderRadius: '0.5rem', fontSize: '0.9rem', fontWeight: 600,
                cursor: !formLabel.trim() || !formAddress.trim() ? 'not-allowed' : 'pointer',
                opacity: !formLabel.trim() || !formAddress.trim() ? 0.6 : 1,
              }}
            >
              {t('common.save', { defaultValue: 'Guardar' })}
            </button>
          </div>
        </div>
      )}

      {/* Add Location Button */}
      {!showForm && (
        <button
          onClick={handleAddNew}
          style={{
            display: 'block', width: '100%', padding: '0.875rem',
            background: 'transparent', color: 'var(--primary)', border: '1px solid var(--primary)',
            borderRadius: '0.75rem', fontSize: '0.95rem', fontWeight: 600, cursor: 'pointer',
          }}
        >
          {t('web.add_location', { defaultValue: '+ Agregar ubicacion' })}
        </button>
      )}
    </main>
  );
}
