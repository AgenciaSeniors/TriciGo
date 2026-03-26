'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, customerService, trustedContactService } from '@tricigo/api';
import type { TrustedContact } from '@tricigo/types';

export default function EmergencyContactPage() {
  const router = useRouter();
  const { t } = useTranslation('web');
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [existingContact, setExistingContact] = useState<TrustedContact | null>(null);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  const loadData = useCallback(async () => {
    if (!userId) return;
    try {
      const profile = await customerService.ensureProfile(userId);
      setProfileId(profile.id);
      if (profile.emergency_contact) {
        setName(profile.emergency_contact.name);
        setPhone(profile.emergency_contact.phone);
        setRelationship(profile.emergency_contact.relationship);
      }

      const contacts = await trustedContactService.getContacts(userId);
      const emergency = contacts.find((c) => c.is_emergency);
      if (emergency) {
        setExistingContact(emergency);
        setName(emergency.name);
        setPhone(emergency.phone);
        setRelationship(emergency.relationship);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('web.emergency_unknown_error', { defaultValue: 'Error desconocido' }));
    }
  }, [userId, t]);

  useEffect(() => {
    if (userId) loadData();
  }, [userId, loadData]);

  const handleSave = async () => {
    if (!profileId || !userId) return;
    if (!name.trim() || name.trim().length < 2) {
      alert(t('web.emergency_name_required', { defaultValue: 'Ingresa el nombre del contacto' }));
      return;
    }
    if (!phone.trim()) {
      alert(t('web.emergency_phone_required', { defaultValue: 'Ingresa un numero de telefono valido' }));
      return;
    }
    setSaving(true);
    setSaved(false);
    try {
      await customerService.updateProfile(profileId, {
        emergency_contact: {
          name: name.trim(),
          phone: phone.trim(),
          relationship: relationship.trim(),
        },
      });

      if (existingContact) {
        await trustedContactService.updateContact(existingContact.id, {
          name: name.trim(),
          phone: phone.trim(),
          relationship: relationship.trim(),
          is_emergency: true,
        });
      } else {
        try {
          await trustedContactService.addContact({
            user_id: userId,
            name: name.trim(),
            phone: phone.trim(),
            relationship: relationship.trim(),
            auto_share: true,
            is_emergency: true,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : t('web.emergency_save_contact_error', { defaultValue: 'Error al guardar contacto' });
          console.error('Error adding emergency contact as trusted contact:', msg);
          // May fail if duplicate phone -- ok, don't block save
        }
      }
      setSaved(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('web.emergency_save_error', { defaultValue: 'Error al guardar contacto de emergencia' });
      console.error('Error saving emergency contact:', msg);
      alert(msg);
    } finally {
      setSaving(false);
    }
  };

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>{t('web.loading', { defaultValue: 'Cargando...' })}</p>
      </div>
    );
  }

  if (!userId) {
    router.replace('/login');
    return null;
  }

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{t('web.emergency_title', { defaultValue: 'Contacto de emergencia' })}</h1>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '0.75rem', padding: '1rem', marginBottom: '1.5rem' }}>
          <p style={{ color: '#c53030', margin: 0, fontSize: '0.9rem' }}>{error}</p>
        </div>
      )}

      <div style={{ background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)', padding: '1.5rem' }}>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 0, marginBottom: '1.25rem', lineHeight: 1.5 }}>
          {t('web.emergency_desc', { defaultValue: 'Este contacto sera notificado en caso de emergencia durante un viaje.' })}
        </p>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>{t('web.emergency_name_label', { defaultValue: 'Nombre' })}</label>
          <input
            type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Juan Perez"
            style={{
              width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
              fontSize: '0.95rem', background: 'var(--bg-page)', color: 'var(--text-primary)', boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>{t('web.emergency_phone_label', { defaultValue: 'Telefono' })}</label>
          <input
            type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
            placeholder="+53 5XXXXXXX"
            style={{
              width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
              fontSize: '0.95rem', background: 'var(--bg-page)', color: 'var(--text-primary)', boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>{t('web.emergency_relationship_label', { defaultValue: 'Relacion' })}</label>
          <input
            type="text" value={relationship} onChange={(e) => setRelationship(e.target.value)}
            placeholder={t('web.relationship_placeholder', { defaultValue: 'Familiar, Amigo...' })}
            style={{
              width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
              fontSize: '0.95rem', background: 'var(--bg-page)', color: 'var(--text-primary)', boxSizing: 'border-box',
            }}
          />
        </div>

        <button
          onClick={handleSave}
          disabled={saving || !name.trim() || !phone.trim()}
          style={{
            display: 'block', width: '100%', padding: '0.875rem', background: 'var(--primary)', color: '#fff',
            border: 'none', borderRadius: '0.75rem', fontSize: '0.95rem', fontWeight: 600,
            cursor: saving ? 'not-allowed' : 'pointer', opacity: saving || !name.trim() || !phone.trim() ? 0.6 : 1,
          }}
        >
          {saving ? t('web.saving', { defaultValue: 'Guardando...' }) : t('web.emergency_save_btn', { defaultValue: 'Guardar' })}
        </button>

        {saved && (
          <p style={{ color: '#16a34a', fontSize: '0.85rem', textAlign: 'center', marginTop: '0.75rem', marginBottom: 0 }}>
            {t('web.emergency_saved', { defaultValue: 'Contacto de emergencia guardado correctamente.' })}
          </p>
        )}
      </div>
    </main>
  );
}
