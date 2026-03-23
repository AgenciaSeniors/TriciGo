'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseClient, trustedContactService } from '@tricigo/api';
import type { TrustedContact } from '@tricigo/types';

const MAX_CONTACTS = 5;

export default function TrustedContactsPage() {
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
      setError(err instanceof Error ? err.message : 'Error desconocido');
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
      alert('No se pudo actualizar el contacto');
    }
  };

  const handleDelete = async (contact: TrustedContact) => {
    if (!confirm(`Eliminar a ${contact.name}?`)) return;
    try {
      await trustedContactService.deleteContact(contact.id);
      setContacts((prev) => prev.filter((c) => c.id !== contact.id));
    } catch {
      alert('No se pudo eliminar el contacto');
    }
  };

  const handleAdd = async () => {
    if (!userId || !newName.trim() || !newPhone.trim()) return;
    setAdding(true);
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
      alert(err?.message === 'Maximum contacts reached' ? 'Maximo de contactos alcanzado' : 'Error al agregar contacto');
    } finally {
      setAdding(false);
    }
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

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>Contactos de confianza</h1>
      </div>

      <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1.5rem', lineHeight: 1.5 }}>
        Estas personas seran notificadas si activas el boton SOS durante un viaje.
      </p>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '0.75rem', padding: '1rem', marginBottom: '1rem' }}>
          <p style={{ color: '#c53030', margin: 0, fontSize: '0.9rem' }}>{error}</p>
          <button onClick={() => { setError(null); loadContacts(); }} style={{ marginTop: '0.5rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem' }}>
            Reintentar
          </button>
        </div>
      )}

      {/* Contact List */}
      {loading ? (
        <p style={{ color: 'var(--text-tertiary)', textAlign: 'center', padding: '2rem 0' }}>Cargando contactos...</p>
      ) : contacts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem 1rem', background: 'var(--bg-card)', borderRadius: '1rem', border: '1px solid var(--border-light)' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--border)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 00-3-3.87" />
            <path d="M16 3.13a4 4 0 010 7.75" />
          </svg>
          <p style={{ color: 'var(--text-tertiary)', margin: '1rem 0 0', fontSize: '0.9rem' }}>
            No tienes contactos de confianza aun.
          </p>
        </div>
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
                        Emergencia
                      </span>
                    )}
                  </div>
                  <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{contact.phone}</p>
                  {contact.relationship && (
                    <p style={{ margin: '0.15rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>{contact.relationship}</p>
                  )}
                </div>
                <button onClick={() => handleDelete(contact)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.25rem', color: 'var(--text-tertiary)' }}>
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
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Compartir viaje automaticamente</span>
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
          + Agregar contacto
        </button>
      )}

      {contacts.length >= MAX_CONTACTS && (
        <p style={{ textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '0.85rem', marginTop: '1rem' }}>
          Has alcanzado el maximo de {MAX_CONTACTS} contactos.
        </p>
      )}

      {showForm && (
        <div style={{
          marginTop: '1.5rem', background: 'var(--bg-card)', borderRadius: '1rem',
          border: '1px solid var(--border-light)', padding: '1.5rem',
        }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 1rem' }}>Nuevo contacto</h3>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>Nombre</label>
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
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>Telefono</label>
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
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>Relacion</label>
            <input
              type="text" value={newRelationship} onChange={(e) => setNewRelationship(e.target.value)}
              placeholder="Familiar, Amigo..."
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
              Cancelar
            </button>
            <button
              onClick={handleAdd} disabled={adding || !newName.trim() || !newPhone.trim()}
              style={{
                flex: 1, padding: '0.75rem', background: 'var(--primary)', color: '#fff',
                border: 'none', borderRadius: '0.5rem', fontSize: '0.9rem', fontWeight: 600,
                cursor: adding ? 'not-allowed' : 'pointer', opacity: adding || !newName.trim() || !newPhone.trim() ? 0.6 : 1,
              }}
            >
              {adding ? 'Agregando...' : 'Agregar'}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
