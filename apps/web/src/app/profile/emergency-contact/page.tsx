'use client';

/**
 * Emergency contact (web) — parity con apps/client/app/profile/emergency-contact.
 * Stores the rider's emergency contact in BOTH customer_profiles.emergency_contact
 * (JSONB, backward compat) AND trusted_contacts with is_emergency=true + auto_share,
 * so SOS broadcasts reach them. Reached from /profile/safety.
 */
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseClient, customerService, trustedContactService } from '@tricigo/api';
import { isValidCubanPhone } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { CustomerProfile, TrustedContact } from '@tricigo/types';

export default function EmergencyContactPage() {
  const router = useRouter();
  const { t } = useTranslation('common');

  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [existingContact, setExistingContact] = useState<TrustedContact | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!authLoading && !userId) router.replace('/login');
  }, [authLoading, userId, router]);

  const loadData = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const cp = await customerService.ensureProfile(userId);
      setProfile(cp);
      if (cp.emergency_contact) {
        setName(cp.emergency_contact.name);
        setPhone(cp.emergency_contact.phone);
        setRelationship(cp.emergency_contact.relationship);
      }
      // Prefer an existing is_emergency trusted contact if present.
      try {
        const contacts = await trustedContactService.getContacts(userId);
        const emergency = contacts.find((c) => c.is_emergency);
        if (emergency) {
          setExistingContact(emergency);
          setName(emergency.name);
          setPhone(emergency.phone);
          setRelationship(emergency.relationship ?? '');
        }
      } catch { /* trusted_contacts optional */ }
    } catch {
      setError('No se pudo cargar tu información. Intentá de nuevo.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) loadData();
  }, [userId, loadData]);

  async function handleSave() {
    if (!profile || !userId) return;
    if (name.trim().length < 2) { setError('Ingresá el nombre del contacto.'); return; }
    if (!isValidCubanPhone(phone.trim())) { setError('Ingresá un número de teléfono cubano válido.'); return; }
    setSaving(true);
    setError(null);
    try {
      // 1. trusted_contacts FIRST — it's the step that can fail with a real
      //    business rule (MAX_CONTACTS at 5). The old order wrote the
      //    customer_profiles JSONB first, so a MAX failure left a half-saved
      //    state: the contact "configured" in /profile/safety but invisible
      //    to the SOS broadcast, while the UI said it failed.
      if (existingContact) {
        await trustedContactService.updateContact(existingContact.id, {
          name: name.trim(), phone: phone.trim(), relationship: relationship.trim(), is_emergency: true,
        });
      } else {
        try {
          await trustedContactService.addContact({
            user_id: userId, name: name.trim(), phone: phone.trim(),
            relationship: relationship.trim(), auto_share: true, is_emergency: true,
          });
        } catch (err: unknown) {
          const msg = String((err as { message?: string; code?: string } | null)?.message ?? err ?? '');
          const code = String((err as { code?: string } | null)?.code ?? '');
          if (code === 'MAX_CONTACTS' || /Maximum contacts/i.test(msg)) {
            setError('Tienes el máximo de 5 contactos de confianza. Marca uno existente como emergencia o elimina uno primero.');
            setSaving(false);
            return;
          }
          // Ignore duplicate-phone — trusted_contacts already has this number.
          if (!/duplicate|unique|23505/.test(msg)) throw err;
        }
      }
      // 2. customer_profiles JSONB (backward compat) after the gate passed.
      await customerService.updateProfile(profile.id, {
        emergency_contact: { name: name.trim(), phone: phone.trim(), relationship: relationship.trim() },
      });
      setSaved(true);
      setTimeout(() => router.push('/profile/safety'), 800);
    } catch {
      setError('No se pudo guardar el contacto de emergencia.');
    } finally {
      setSaving(false);
    }
  }

  if (authLoading || !userId) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </div>
          <p style={{ fontSize: '0.875rem' }}>Cargando...</p>
        </div>
      </div>
    );
  }

  const inputStyle = { width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)', fontSize: '0.95rem' } as const;
  const valid = name.trim().length >= 2 && phone.trim().length > 0;

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
        <Link href="/profile/safety" style={{ color: 'var(--text-primary)', textDecoration: 'none' }} aria-label="Volver a seguridad">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
          {t('profile.emergency_contact_title', { defaultValue: 'Contacto de emergencia' })}
        </h1>
      </div>

      <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: '0 0 1.5rem', lineHeight: 1.5 }}>
        Esta persona recibirá un SMS automático si activás el SOS durante un viaje.
      </p>

      {loading ? (
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>Cargando...</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label htmlFor="ec-name" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>
              {t('profile.emergency_name', { defaultValue: 'Nombre' })}
            </label>
            <input id="ec-name" type="text" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="Juan Pérez" style={inputStyle} />
          </div>
          <div>
            <label htmlFor="ec-phone" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>
              {t('profile.emergency_phone', { defaultValue: 'Teléfono' })}
            </label>
            <input id="ec-phone" type="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setError(null); }} placeholder="+53 5XXXXXXX o 6XXXXXXX" style={inputStyle} />
          </div>
          <div>
            <label htmlFor="ec-relationship" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>
              {t('profile.emergency_relationship', { defaultValue: 'Relación' })}
            </label>
            <input id="ec-relationship" type="text" value={relationship} onChange={(e) => setRelationship(e.target.value)} placeholder="Familiar, Amigo..." style={inputStyle} />
          </div>

          <div aria-live="polite">
            {error && <p style={{ color: 'var(--error, #dc2626)', fontSize: '0.85rem', margin: 0 }}>{error}</p>}
            {saved && <p style={{ color: 'var(--success, #16a34a)', fontSize: '0.85rem', margin: 0 }}>Contacto de emergencia guardado ✓</p>}
          </div>

          <button
            onClick={handleSave}
            disabled={!valid || saving}
            style={{ width: '100%', padding: '0.875rem', borderRadius: '0.75rem', border: 'none', background: valid && !saving ? 'var(--primary)' : 'var(--border)', color: valid && !saving ? 'white' : 'var(--text-tertiary)', fontWeight: 600, fontSize: '0.95rem', cursor: valid && !saving ? 'pointer' : 'not-allowed' }}
          >
            {saving ? 'Guardando...' : t('save', { defaultValue: 'Guardar' })}
          </button>
        </div>
      )}
    </main>
  );
}
