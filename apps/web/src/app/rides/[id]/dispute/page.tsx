'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { disputeService, getSupabaseClient } from '@tricigo/api';
import type { DisputeReason } from '@tricigo/types';

// Mismo set de motivos que mobile (apps/client/app/ride/dispute/[rideId].tsx).
// Antes faltaba 'lost_item' acá, lo cual deshabilitaba ese motivo en el
// flow web aunque la app móvil sí lo permitía.
const REASONS: { value: DisputeReason; label: string }[] = [
  { value: 'wrong_fare', label: 'Cobro incorrecto' },
  { value: 'unauthorized_charge', label: 'Cargo no autorizado' },
  { value: 'safety_issue', label: 'Problema de seguridad' },
  { value: 'driver_behavior', label: 'Comportamiento del conductor' },
  { value: 'vehicle_condition', label: 'Condicion del vehiculo' },
  { value: 'wrong_route', label: 'Ruta incorrecta' },
  { value: 'service_not_rendered', label: 'Servicio no prestado' },
  { value: 'excessive_wait', label: 'Espera excesiva' },
  { value: 'lost_item', label: 'Objeto perdido' },
  { value: 'other', label: 'Otro' },
];

// Cap de fotos igual que mobile (apps/client/app/ride/dispute/[rideId].tsx:74).
const MAX_EVIDENCE_FILES = 4;

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
  // Selected files (not yet uploaded). Web equivalent of `evidenceUris`
  // in mobile (apps/client/app/ride/dispute/[rideId].tsx:69). Replaces
  // the previous URL-textarea UX which forced the user to host their
  // own images first — bad UX, often skipped, hurt evidence quality.
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
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

  // Mirror de mobile uploadEvidence (apps/client/app/ride/dispute/[rideId].tsx:90-115):
  // sube cada archivo al bucket 'dispute-evidence' bajo el path
  // `disputes/{rideId}/{userId}/{ts}_{i}.{ext}` y devuelve los public URLs.
  // Mobile usa fetch(uri).blob() para convertir; web ya recibe File por
  // el input — más directo.
  const uploadEvidence = async (): Promise<string[]> => {
    if (evidenceFiles.length === 0) return [];
    const supabase = getSupabaseClient();
    const urls: string[] = [];
    for (let i = 0; i < evidenceFiles.length; i++) {
      const file = evidenceFiles[i]!;
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const storagePath = `disputes/${rideId}/${userId}/${Date.now()}_${i}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from('dispute-evidence')
        .upload(storagePath, file, { contentType: file.type || `image/${ext}`, upsert: false });
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage
        .from('dispute-evidence')
        .getPublicUrl(storagePath);
      urls.push(urlData.publicUrl);
    }
    return urls;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || !rideId || !userId || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      setUploadingFiles(true);
      const urls = await uploadEvidence();
      setUploadingFiles(false);

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
          background: 'var(--success, #16a34a)', color: 'white', padding: '0.75rem 1.5rem',
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
      setUploadingFiles(false);
    }
  };

  const handleFilesPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    if (picked.length === 0) return;
    // Cap at MAX_EVIDENCE_FILES total (existing + new) — mismo límite
    // que mobile.
    setEvidenceFiles((prev) => [...prev, ...picked].slice(0, MAX_EVIDENCE_FILES));
    // Reset input value so the same file can be picked again later
    // (browser dedupe sino).
    e.target.value = '';
  };

  const removeFile = (index: number) => {
    setEvidenceFiles((prev) => prev.filter((_, i) => i !== index));
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
            background: 'rgba(239,68,68,0.12)', color: 'var(--error)', fontSize: '0.85rem', fontWeight: 500,
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

          {/* Evidence — file upload (parity con mobile ImagePicker, PR #B10) */}
          <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            Evidencia (opcional · máx. {MAX_EVIDENCE_FILES} fotos)
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
            {evidenceFiles.map((file, idx) => {
              const previewUrl = URL.createObjectURL(file);
              return (
                <div key={`${file.name}-${idx}`} style={{ position: 'relative', width: 80, height: 80 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewUrl}
                    alt={file.name}
                    style={{
                      width: '100%', height: '100%',
                      objectFit: 'cover', borderRadius: '0.5rem',
                      border: '1px solid var(--border-light)',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => removeFile(idx)}
                    aria-label={`Quitar ${file.name}`}
                    style={{
                      position: 'absolute', top: -6, right: -6,
                      width: 22, height: 22, borderRadius: '50%',
                      border: 'none', background: 'var(--bg-card)',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
                      fontSize: '0.75rem', cursor: 'pointer',
                      lineHeight: 1, color: '#dc2626', fontWeight: 700,
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {evidenceFiles.length < MAX_EVIDENCE_FILES && (
              <label
                style={{
                  width: 80, height: 80, borderRadius: '0.5rem',
                  border: '1px dashed var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', color: 'var(--text-tertiary)',
                  fontSize: '1.5rem', background: 'var(--bg-page)',
                }}
              >
                +
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleFilesPicked}
                  style={{ display: 'none' }}
                />
              </label>
            )}
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '1.5rem' }}>
            {evidenceFiles.length > 0
              ? `${evidenceFiles.length}/${MAX_EVIDENCE_FILES} archivos seleccionados.`
              : 'Adjuntá fotos de tu recibo, conversación, o lo que ayude a entender el problema.'}
          </p>

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
            {uploadingFiles ? 'Subiendo evidencia...' : submitting ? 'Enviando...' : 'Enviar reporte'}
          </button>
        </form>
      </div>
    </main>
  );
}
