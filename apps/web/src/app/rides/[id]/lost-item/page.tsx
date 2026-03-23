'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { lostItemService, rideService, getSupabaseClient } from '@tricigo/api';
import type { LostItemCategory } from '@tricigo/types';

const CATEGORIES: { value: LostItemCategory; label: string; icon: string }[] = [
  { value: 'phone', label: 'Telefono', icon: '📱' },
  { value: 'wallet', label: 'Billetera', icon: '👛' },
  { value: 'bag', label: 'Bolso', icon: '👜' },
  { value: 'clothing', label: 'Ropa', icon: '👕' },
  { value: 'electronics', label: 'Electronico', icon: '💻' },
  { value: 'documents', label: 'Documentos', icon: '📄' },
  { value: 'keys', label: 'Llaves', icon: '🔑' },
  { value: 'other', label: 'Otro', icon: '📦' },
];

export default function LostItemPage() {
  const router = useRouter();
  const params = useParams();
  const rideId = params?.id as string | undefined;

  // ── Auth state ──
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // ── Ride data (needed for driver_id) ──
  const [driverId, setDriverId] = useState<string | null>(null);
  const [rideLoading, setRideLoading] = useState(true);

  // ── Form state ──
  const [category, setCategory] = useState<LostItemCategory | ''>('');
  const [description, setDescription] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Auth effect ──
  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  // ── Load ride to get driver_id ──
  useEffect(() => {
    if (!userId || !rideId) return;
    let cancelled = false;

    async function loadRide() {
      try {
        const data = await rideService.getRideWithDriver(rideId!);
        if (!cancelled && data) {
          // driver_id is on the base ride; driver_user_id is the joined user id
          setDriverId((data as any).driver_id ?? null);
        }
      } catch {
        // non-critical, form can still be submitted if driver_id found another way
      } finally {
        if (!cancelled) setRideLoading(false);
      }
    }

    loadRide();
    return () => { cancelled = true; };
  }, [userId, rideId]);

  // ── Auth gate (after all hooks) ──
  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </div>
          <p style={{ fontSize: '0.875rem' }}>Cargando...</p>
        </div>
      </div>
    );
  }
  if (!userId) { router.replace('/login'); return null; }

  const isValid = category !== '' && description.trim().length >= 10;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || !rideId || !userId || submitting) return;

    if (!driverId) {
      setError('No se pudo identificar al conductor de este viaje.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const descriptionFull = contactPhone.trim()
        ? `${description.trim()}\n\nTelefono de contacto: ${contactPhone.trim()}`
        : description.trim();

      await lostItemService.reportLostItem({
        ride_id: rideId,
        reporter_id: userId,
        driver_id: driverId,
        description: descriptionFull,
        category: category as LostItemCategory,
        photo_urls: [],
      });

      // Success toast
      if (typeof window !== 'undefined') {
        const toast = document.createElement('div');
        toast.textContent = 'Reporte enviado correctamente';
        Object.assign(toast.style, {
          position: 'fixed', bottom: '2rem', left: '50%', transform: 'translateX(-50%)',
          background: '#16a34a', color: 'white', padding: '0.75rem 1.5rem',
          borderRadius: '0.75rem', fontSize: '0.875rem', fontWeight: '600',
          zIndex: '9999', boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        });
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
      }
      router.push(`/rides/${rideId}`);
    } catch (err: any) {
      if (err?.message?.includes('duplicate') || err?.code === '23505') {
        setError('Ya reportaste un objeto perdido para este viaje.');
      } else {
        setError(err?.message ?? 'Error al enviar el reporte');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '1rem' }}>
      <div style={{ maxWidth: 500, width: '100%' }}>
        <Link href={`/rides/${rideId}`} style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>
          &larr; Volver al viaje
        </Link>

        <h1 style={{ fontSize: 'clamp(1.25rem, 4vw, 1.75rem)', fontWeight: 800, marginTop: '1rem', marginBottom: '0.5rem' }}>
          Reportar objeto perdido
        </h1>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)', marginBottom: '1.5rem' }}>
          Notificaremos al conductor para que revise su vehiculo.
        </p>

        {error && (
          <div style={{
            padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '0.75rem',
            background: '#fee2e2', color: '#dc2626', fontSize: '0.85rem', fontWeight: 500,
          }}>
            {error}
          </div>
        )}

        {rideLoading ? (
          <div style={{ textAlign: 'center', padding: '3rem 0', color: 'var(--text-tertiary)' }}>
            <p style={{ fontSize: '0.875rem' }}>Cargando datos del viaje...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {/* Category picker */}
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
              Tipo de objeto
            </label>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem',
              marginBottom: '1.25rem',
            }}>
              {CATEGORIES.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setCategory(c.value)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    justifyContent: 'center', padding: '0.75rem 0.25rem',
                    borderRadius: '0.75rem', cursor: 'pointer',
                    border: category === c.value
                      ? '2px solid var(--primary)'
                      : '1px solid var(--border-light)',
                    background: category === c.value
                      ? 'rgba(var(--primary-rgb, 249,115,22), 0.08)'
                      : 'var(--bg-card)',
                  }}
                >
                  <span style={{ fontSize: '1.5rem', marginBottom: '0.25rem' }}>{c.icon}</span>
                  <span style={{
                    fontSize: '0.7rem', fontWeight: category === c.value ? 600 : 400,
                    color: category === c.value ? 'var(--primary)' : 'var(--text-secondary)',
                  }}>
                    {c.label}
                  </span>
                </button>
              ))}
            </div>

            {/* Description */}
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
              Descripcion del objeto (minimo 10 caracteres)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe el objeto que perdiste..."
              rows={4}
              style={{
                width: '100%', padding: '0.75rem', borderRadius: '0.75rem',
                border: '1px solid var(--border-light)', fontSize: '0.875rem',
                resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box',
                marginBottom: '1.25rem',
              }}
            />

            {/* Contact phone */}
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
              Telefono de contacto
            </label>
            <input
              type="tel"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="+53 5XXXXXXX"
              style={{
                width: '100%', padding: '0.75rem', borderRadius: '0.75rem',
                border: '1px solid var(--border-light)', fontSize: '0.875rem',
                fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: '1.5rem',
              }}
            />

            {/* Submit */}
            <button
              type="submit"
              disabled={!isValid || submitting}
              style={{
                width: '100%', padding: '0.875rem', borderRadius: '0.75rem',
                background: isValid && !submitting ? 'var(--primary)' : 'var(--border-light)',
                color: isValid && !submitting ? 'white' : 'var(--text-tertiary)',
                border: 'none', fontSize: '0.95rem', fontWeight: 700,
                cursor: isValid && !submitting ? 'pointer' : 'not-allowed',
                transition: 'opacity 0.2s',
              }}
            >
              {submitting ? 'Enviando...' : 'Enviar reporte'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
