'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { disputeService, getSupabaseClient } from '@tricigo/api';
import type { DisputeReason } from '@tricigo/types';

const REASONS: { value: DisputeReason; label: string }[] = [
  { value: 'wrong_fare', label: 'Cobro incorrecto' },
  { value: 'unauthorized_charge', label: 'Cargo no autorizado' },
  { value: 'safety_issue', label: 'Problema de seguridad' },
  { value: 'driver_behavior', label: 'Comportamiento del conductor' },
  { value: 'vehicle_condition', label: 'Condicion del vehiculo' },
  { value: 'wrong_route', label: 'Ruta incorrecta' },
  { value: 'service_not_rendered', label: 'Servicio no prestado' },
  { value: 'excessive_wait', label: 'Espera excesiva' },
  { value: 'other', label: 'Otro' },
];

export default function DisputePage() {
  const router = useRouter();
  const params = useParams();
  const rideId = params?.id as string | undefined;

  // ── Auth state ──
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // ── Form state ──
  const [reason, setReason] = useState<DisputeReason | ''>('');
  const [description, setDescription] = useState('');
  const [evidenceUrls, setEvidenceUrls] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Auth effect ──
  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

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

  const isValid = reason !== '' && description.trim().length >= 10;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || !rideId || !userId || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const urls = evidenceUrls
        .split('\n')
        .map((u) => u.trim())
        .filter((u) => u.length > 0);

      await disputeService.createDispute({
        ride_id: rideId,
        opened_by: userId,
        reason: reason as DisputeReason,
        description: description.trim(),
        evidence_urls: urls.length > 0 ? urls : undefined,
      });

      // Success toast via simple alert, then redirect
      if (typeof window !== 'undefined') {
        const toast = document.createElement('div');
        toast.textContent = 'Disputa enviada correctamente';
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
      setError(err?.message ?? 'Error al enviar la disputa');
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
          Reportar un problema
        </h1>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)', marginBottom: '1.5rem' }}>
          Describe el problema que tuviste con tu viaje. Revisaremos tu caso en un plazo de 72 horas.
        </p>

        {error && (
          <div style={{
            padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '0.75rem',
            background: '#fee2e2', color: '#dc2626', fontSize: '0.85rem', fontWeight: 500,
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Reason selector */}
          <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            Motivo del reporte
          </label>
          <div style={{
            border: '1px solid var(--border-light)', borderRadius: '0.75rem',
            overflow: 'hidden', marginBottom: '1.25rem', background: 'var(--bg-card)',
          }}>
            {REASONS.map((r) => (
              <label
                key={r.value}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.75rem 1rem', cursor: 'pointer',
                  borderBottom: '1px solid var(--border-light)',
                  background: reason === r.value ? 'rgba(var(--primary-rgb, 249,115,22), 0.08)' : 'transparent',
                }}
              >
                <span style={{
                  width: 18, height: 18, borderRadius: '50%',
                  border: reason === r.value ? '5px solid var(--primary)' : '2px solid var(--border)',
                  flexShrink: 0, boxSizing: 'border-box',
                }} />
                <input
                  type="radio"
                  name="reason"
                  value={r.value}
                  checked={reason === r.value}
                  onChange={() => setReason(r.value)}
                  style={{ display: 'none' }}
                />
                <span style={{ fontSize: '0.875rem', fontWeight: reason === r.value ? 600 : 400 }}>
                  {r.label}
                </span>
              </label>
            ))}
          </div>

          {/* Description */}
          <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            Descripcion (minimo 10 caracteres)
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe lo que sucedio..."
            rows={5}
            style={{
              width: '100%', padding: '0.75rem', borderRadius: '0.75rem',
              border: '1px solid var(--border-light)', fontSize: '0.875rem',
              resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box',
              marginBottom: '0.25rem',
            }}
          />
          <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '1.25rem' }}>
            {description.trim().length}/10 caracteres minimos
          </p>

          {/* Evidence URLs */}
          <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            URLs de evidencia (opcional)
          </label>
          <textarea
            value={evidenceUrls}
            onChange={(e) => setEvidenceUrls(e.target.value)}
            placeholder="Pega enlaces a capturas o fotos (uno por linea)"
            rows={3}
            style={{
              width: '100%', padding: '0.75rem', borderRadius: '0.75rem',
              border: '1px solid var(--border-light)', fontSize: '0.875rem',
              resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box',
              marginBottom: '1.5rem',
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
      </div>
    </main>
  );
}
