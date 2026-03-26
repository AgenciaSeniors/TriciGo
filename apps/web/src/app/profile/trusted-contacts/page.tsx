'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseClient, trustedContactService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { TrustedContact } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

const MAX_CONTACTS = 5;

export default function TrustedContactsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [contacts, setContacts] = useState<TrustedContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add form state
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newRelationship, setNewRelationship] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  const loadContacts = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await trustedContactService.getContacts(userId);
      setContacts(data);
    } catch (err) {
      // Only show error if we have NO contacts loaded (initial load failure)
      if (contacts.length === 0) {
        setError(err instanceof Error ? err.message : t('web.unknown_error', { defaultValue: 'Error desconocido' }));
      }
      // If contacts exist, silently fail reload — data is already displayed
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) loadContacts();
  }, [userId, loadContacts]);

  const handleToggleAutoShare = async (contact: TrustedContact) => {
    try {
      const updated = await trustedContactService.updateContact(contact.id, {
        auto_share: !contact.auto_share,
      });
      setContacts((prev) => prev.map((c) => (c.id === contact.id ? updated : c)));
    } catch {
      alert(t('web.update_contact_error', { defaultValue: 'No se pudo actualizar el contacto' }));
    }
  };

  const handleDelete = async (contact: TrustedContact) => {
    if (!confirm(t('web.delete_contact_confirm', { defaultValue: 'Eliminar a {{name}}?', name: contact.name }))) return;
    try {
      await trustedContactService.deleteContact(contact.id);
      setContacts((prev) => prev.filter((c) => c.id !== contact.id));
    } catch {
      alert(t('web.delete_contact_error', { defaultValue: 'No se pudo eliminar el contacto' }));
    }
  };

  const handleAdd = async () => {
    if (!userId || !newName.trim() || !newPhone.trim()) return;
    setAdding(true);
    setError(null); // Clear any previous error
    try {
      await trustedContactService.addContact({
        user_id: userId,
        name: newName.trim(),
        phone: newPhone.trim(),
        relationship: newRelationship.trim(),
        auto_share: true,
      });
      setNewName('');
      setNewPhone('');
      setNewRelationship('');
      setShowForm(false);
      await loadContacts();
    } catch (err: any) {
      console.error('Error adding trusted contact:', err);
      if (err?.message === 'Maximum contacts reached') {
        alert(t('web.max_contacts_reached', { defaultValue: 'Maximo de contactos alcanzado ({{max}}).', max: MAX_CONTACTS }));
      } else if (err?.message?.includes('duplicate')) {
        alert(t('web.duplicate_contact', { defaultValue: 'Este contacto ya existe. Verifica el numero de telefono.' }));
      } else {
        alert(t('web.add_contact_error', { defaultValue: 'Error al agregar contacto: {{error}}', error: err?.message || t('web.unknown_error', { defaultValue: 'Error desconocido. Intenta de nuevo.' }) }));
      }
    } finally {
      setAdding(false);
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
    router.replace('/login');
    return null;
  }

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" aria-label="Volver al perfil" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{t('web.trusted_contacts', { defaultValue: 'Contactos de confianza' })}</h1>
      </div>

      <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1.5rem', lineHeight: 1.5 }}>
        {t('web.trusted_contacts_desc', { defaultValue: 'Estas personas seran notificadas si activas el boton SOS durante un viaje.' })}
      </p>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '0.75rem', padding: '1rem', marginBottom: '1rem' }}>
          <p style={{ color: '#c53030', margin: 0, fontSize: '0.9rem' }}>{error}</p>
          <button onClick={() => { setError(null); loadContacts(); }} style={{ marginTop: '0.5rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem' }}>
            {t('common.retry', { defaultValue: 'Reintentar' })}
          </button>
        </div>
      )}

      {/* Contact List */}
      {loading ? (
        <WebSkeletonList count={3} />
      ) : contacts.length === 0 ? (
        <WebEmptyState
          icon="👥"
          title={t('web.no_trusted_contacts', { defaultValue: 'No tienes contactos de confianza aun' })}
          description={t('web.trusted_contacts_desc', { defaultValue: 'Estas personas seran notificadas si activas el boton SOS durante un viaje.' })}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {contacts.map((contact) => (
            <div key={contact.id} style={{
              background: 'var(--bg-card)',
              borderRadius: '1rem',
              border: '1px solid var(--border-light)',
              padding: '1.25rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>{contact.name}</span>
                    {contact.is_emergency && (
                      <span style={{ background: '#e53e3e', color: '#fff', fontSize: '0.7rem', fontWeight: 600, padding: '0.15rem 0.5rem', borderRadius: '999px' }}>
                        {t('web.emergency', { defaultValue: 'Emergencia' })}
                      </span>
                    )}
                  </div>
                  <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{contact.phone}</p>
                  {contact.relationship && (
                    <p style={{ margin: '0.15rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>{contact.relationship}</p>
                  )}
                </div>
                <button onClick={() => handleDelete(contact)} aria-label={`Eliminar contacto ${contact.name}`} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.25rem', color: 'var(--text-tertiary)' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                  </svg>
                </button>
              </div>

              {/* Auto-share toggle */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-light)',
              }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('web.auto_share_trip', { defaultValue: 'Compartir viaje automaticamente' })}</span>
                <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24 }}>
                  <input
                    type="checkbox"
                    checked={contact.auto_share}
                    onChange={() => handleToggleAutoShare(contact)}
                    style={{ opacity: 0, width: 0, height: 0 }}
                  />
                  <span style={{
                    position: 'absolute', cursor: 'pointer', inset: 0, borderRadius: 24,
                    background: contact.auto_share ? 'var(--primary)' : '#ccc',
                    transition: 'background 0.2s',
                  }}>
                    <span style={{
                      position: 'absolute', height: 18, width: 18, left: contact.auto_share ? 22 : 3, bottom: 3,
                      background: '#fff', borderRadius: '50%', transition: 'left 0.2s',
                    }} />
                  </span>
                </label>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Contact Button / Form */}
      {!showForm && contacts.length < MAX_CONTACTS && (
        <button
          onClick={() => setShowForm(true)}
          style={{
            display: 'block', width: '100%', marginTop: '1.5rem', padding: '0.875rem',
            background: 'transparent', color: 'var(--primary)', border: '1px solid var(--primary)',
            borderRadius: '0.75rem', fontSize: '0.95rem', fontWeight: 600, cursor: 'pointer',
          }}
        >
          {t('web.add_contact', { defaultValue: '+ Agregar contacto' })}
        </button>
      )}

      {contacts.length >= MAX_CONTACTS && (
        <p style={{ textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '0.85rem', marginTop: '1rem' }}>
          {t('web.max_contacts_reached', { defaultValue: 'Has alcanzado el maximo de {{max}} contactos.', max: MAX_CONTACTS })}
        </p>
      )}

      {showForm && (
        <div style={{
          marginTop: '1.5rem', background: 'var(--bg-card)', borderRadius: '1rem',
          border: '1px solid var(--border-light)', padding: '1.5rem',
        }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 1rem' }}>{t('web.new_contact', { defaultValue: 'Nuevo contacto' })}</h3>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>{t('web.name', { defaultValue: 'Nombre' })}</label>
            <input
              type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="Juan Perez"
              style={{
                width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
                fontSize: '0.95rem', background: 'var(--bg-page)', color: 'var(--text-primary)', boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>{t('web.phone', { defaultValue: 'Telefono' })}</label>
            <input
              type="tel" value={newPhone} onChange={(e) => setNewPhone(e.target.value)}
              placeholder="+53 5XXXXXXX"
              style={{
                width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
                fontSize: '0.95rem', background: 'var(--bg-page)', color: 'var(--text-primary)', boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>{t('web.relationship', { defaultValue: 'Relacion' })}</label>
            <input
              type="text" value={newRelationship} onChange={(e) => setNewRelationship(e.target.value)}
              placeholder={t('web.relationship_placeholder', { defaultValue: 'Familiar, Amigo...' })}
              style={{
                width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
                fontSize: '0.95rem', background: 'var(--bg-page)', color: 'var(--text-primary)', boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              onClick={() => { setShowForm(false); setNewName(''); setNewPhone(''); setNewRelationship(''); }}
              style={{
                flex: 1, padding: '0.75rem', background: 'transparent', color: 'var(--text-secondary)',
                border: '1px solid var(--border)', borderRadius: '0.5rem', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer',
              }}
            >
              {t('common.cancel', { defaultValue: 'Cancelar' })}
            </button>
            <button
              onClick={handleAdd} disabled={adding || !newName.trim() || !newPhone.trim()}
              style={{
                flex: 1, padding: '0.75rem', background: 'var(--primary)', color: '#fff',
                border: 'none', borderRadius: '0.5rem', fontSize: '0.9rem', fontWeight: 600,
                cursor: adding ? 'not-allowed' : 'pointer', opacity: adding || !newName.trim() || !newPhone.trim() ? 0.6 : 1,
              }}
            >
              {adding ? t('web.adding', { defaultValue: 'Agregando...' }) : t('web.add', { defaultValue: 'Agregar' })}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
