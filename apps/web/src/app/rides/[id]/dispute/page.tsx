'use client';

// ============================================================
// Web dispute form — mirror of apps/client/app/ride/dispute/[rideId].tsx
// (PASS2 PR-J: close the web↔app parity gap for formal disputes).
//
// Same reasons, validations and submit path as mobile:
//   - reason picker (10 DisputeReason values) + required description
//   - up to 4 evidence photos → bucket `dispute-evidence` via the
//     storage-upload Edge Function (Storage rejects the browser's ES256
//     user JWT as anon, so a direct .upload() fails RLS — same workaround
//     as the web avatar upload in profile/edit/page.tsx)
//   - submit via disputeService.createDispute (shared @tricigo/api service)
//
// Gating mirrors mobile: feature flag `formal_disputes_enabled`, ride must
// be `completed`, and only one dispute per ride.
// ============================================================

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import { getSupabaseClient, rideService, disputeService, useFeatureFlag } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { getErrorMessage } from '@tricigo/utils';
import type { RideWithDriver, RideDispute, DisputeReason } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

const REASONS: DisputeReason[] = [
  'wrong_fare',
  'wrong_route',
  'driver_behavior',
  'vehicle_condition',
  'safety_issue',
  'unauthorized_charge',
  'service_not_rendered',
  'excessive_wait',
  'lost_item',
  'other',
];

// Spanish fallbacks match packages/i18n/src/locales/es/rider.json exactly —
// real translations (es/en/pt) resolve from the shared `rider` namespace.
const REASON_FALLBACK: Record<DisputeReason, string> = {
  wrong_fare: 'Tarifa incorrecta',
  wrong_route: 'Ruta incorrecta',
  driver_behavior: 'Comportamiento del conductor',
  vehicle_condition: 'Condición del vehículo',
  safety_issue: 'Problema de seguridad',
  unauthorized_charge: 'Cobro no autorizado',
  service_not_rendered: 'Servicio no prestado',
  excessive_wait: 'Espera excesiva',
  lost_item: 'Objeto perdido',
  other: 'Otro',
};

const MAX_EVIDENCE_PHOTOS = 4;

// Mirror of the mobile compressImage spec (apps/client/src/lib/compressImage.ts):
// gallery photos are 3–12 MP; several raw uploads over a Cuban 3G link time
// out. ~1600px / q0.7 JPEG → ~150–400 KB each. Canvas re-encode also
// normalizes the MIME to image/jpeg, which always passes the EF whitelist.
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.7;
// Keep in sync with ALLOWED_MIME['dispute-evidence'] in
// supabase/functions/storage-upload/index.ts.
const EF_ALLOWED_MIME = /^image\/(jpe?g|png|webp|heic|heif|gif)$/i;

interface EvidencePhoto {
  blob: Blob;
  contentType: string;
  ext: string;
  previewUrl: string;
}

async function prepareEvidence(file: File): Promise<EvidencePhoto> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas_unavailable');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) throw new Error('encode_failed');
    return { blob, contentType: 'image/jpeg', ext: 'jpg', previewUrl: URL.createObjectURL(blob) };
  } catch {
    // Canvas can't decode some formats (e.g. HEIC outside Safari). Fall back
    // to the raw file when its declared type already passes the EF whitelist.
    if (EF_ALLOWED_MIME.test(file.type)) {
      const ext = (file.type.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
      return { blob: file, contentType: file.type, ext, previewUrl: URL.createObjectURL(file) };
    }
    throw new Error('unsupported_image');
  }
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-light)',
  borderRadius: '0.75rem',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.85rem',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: '0.5rem',
};

export default function RideDisputePage() {
  const { t } = useTranslation('rider');
  const router = useRouter();
  const params = useParams();
  const rideId = params?.id as string | undefined;

  const disputesEnabled = useFeatureFlag('formal_disputes_enabled');

  // ── Auth state ──
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // ── Ride + existing dispute (gating) ──
  const [ride, setRide] = useState<RideWithDriver | null>(null);
  const [existingDispute, setExistingDispute] = useState<RideDispute | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  // ── Form state ──
  const [reason, setReason] = useState<DisputeReason | null>(null);
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<EvidencePhoto[]>([]);
  const [processingPhotos, setProcessingPhotos] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!userId || !rideId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadFailed(false);
      try {
        const [rideData, disputeData] = await Promise.all([
          rideService.getRideWithDriver(rideId),
          disputeService.getDisputeByRide(rideId).catch(() => null),
        ]);
        if (cancelled) return;
        setRide(rideData);
        setExistingDispute(disputeData);
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId, rideId]);

  // Revoke preview object URLs on unmount (deterministic, avoids memory
  // pressure if the user picks/removes photos repeatedly).
  const photosRef = useRef<EvidencePhoto[]>([]);
  useEffect(() => { photosRef.current = photos; }, [photos]);
  useEffect(() => () => { photosRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl)); }, []);

  const onFilesPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Reset so re-picking the same file fires onChange again.
    e.target.value = '';
    if (files.length === 0) return;
    setFormError(null);
    setProcessingPhotos(true);
    try {
      const room = MAX_EVIDENCE_PHOTOS - photos.length;
      const selected = files.slice(0, Math.max(0, room));
      const prepared: EvidencePhoto[] = [];
      let failed = 0;
      for (const file of selected) {
        try {
          prepared.push(await prepareEvidence(file));
        } catch {
          failed += 1;
        }
      }
      if (prepared.length > 0) {
        setPhotos((prev) => [...prev, ...prepared].slice(0, MAX_EVIDENCE_PHOTOS));
      }
      if (failed > 0) {
        setFormError(t('dispute.invalid_image', { defaultValue: 'Algunas imágenes no son válidas y no se agregaron.' }));
      }
    } finally {
      setProcessingPhotos(false);
    }
  };

  const removePhoto = (index: number) => {
    const target = photos[index];
    if (target) URL.revokeObjectURL(target.previewUrl);
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  };

  const uploadEvidence = async (): Promise<string[]> => {
    if (photos.length === 0) return [];
    const supabase = getSupabaseClient();
    const urls: string[] = [];
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i]!;
      const fileName = `${Date.now()}_${i}.${photo.ext}`;
      // Path shape required by the EF authz: disputes/{rideId}/{userId}/{file}
      // (uploader's own folder + party to the ride).
      const storagePath = `disputes/${rideId}/${userId}/${fileName}`;
      const fd = new FormData();
      fd.append('file', photo.blob, fileName);
      fd.append('bucket', 'dispute-evidence');
      fd.append('path', storagePath);
      fd.append('contentType', photo.contentType);
      const { data: upRes, error: uploadErr } = await supabase.functions.invoke('storage-upload', { body: fd });
      if (uploadErr) {
        throw new Error(t('dispute.evidence_upload_failed', { defaultValue: 'No se pudo subir la foto {{n}}. Intenta de nuevo.', n: i + 1 }));
      }
      if ((upRes as { error?: string } | null)?.error) {
        throw new Error(String((upRes as { error?: string }).error));
      }
      const { data: urlData } = supabase.storage.from('dispute-evidence').getPublicUrl(storagePath);
      urls.push(urlData.publicUrl);
    }
    return urls;
  };

  const handleSubmit = async () => {
    if (!reason || !description.trim() || !rideId || !userId || submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const evidenceUrls = await uploadEvidence();
      await disputeService.createDispute({
        ride_id: rideId,
        opened_by: userId,
        reason,
        description: description.trim(),
        evidence_urls: evidenceUrls,
      });
      setSubmitted(true);
    } catch (err: unknown) {
      setFormError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ── Gates (same priority as mobile) ──
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

  const backHref = `/rides/${rideId ?? ''}`;

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1.5rem' }}>
      <Link href={backHref} aria-label={t('dispute.back_to_ride', { defaultValue: 'Volver al viaje' })} style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </Link>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{t('dispute.title', { defaultValue: 'Disputa de viaje' })}</h1>
    </div>
  );

  if (!disputesEnabled) {
    return (
      <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
        {header}
        <WebEmptyState
          icon="🚧"
          title={t('dispute.feature_unavailable', { defaultValue: 'Función no disponible' })}
          description={t('dispute.feature_unavailable_desc', { defaultValue: 'Las disputas no están disponibles por ahora.' })}
          action={{ label: t('dispute.back_to_ride', { defaultValue: 'Volver al viaje' }), href: backHref }}
        />
      </main>
    );
  }

  if (loading) {
    return (
      <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
        {header}
        <WebSkeletonList count={3} />
      </main>
    );
  }

  if (loadFailed || !ride) {
    return (
      <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
        {header}
        <WebEmptyState
          icon="⚠️"
          title={loadFailed
            ? t('web.ride_load_error', { defaultValue: 'Error al cargar el viaje' })
            : t('web.ride_not_found', { defaultValue: 'Viaje no encontrado' })}
          action={{ label: t('dispute.back_to_ride', { defaultValue: 'Volver al viaje' }), href: backHref }}
        />
      </main>
    );
  }

  // One dispute per ride — check BEFORE the status gate (a disputed ride
  // already has a dispute; its status card lives on the ride detail).
  if (existingDispute) {
    return (
      <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
        {header}
        <WebEmptyState
          icon="📋"
          title={t('dispute.dispute_exists', { defaultValue: 'Ya existe una disputa para este viaje' })}
          description={t('dispute.dispute_exists_desc', { defaultValue: 'Puedes ver su estado en el detalle del viaje.' })}
          action={{ label: t('dispute.back_to_ride', { defaultValue: 'Volver al viaje' }), href: backHref }}
        />
      </main>
    );
  }

  // Mobile only surfaces the dispute CTA for completed rides.
  if (ride.status !== 'completed') {
    return (
      <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
        {header}
        <WebEmptyState
          icon="⚠️"
          title={t('dispute.not_disputable', { defaultValue: 'Este viaje no se puede disputar' })}
          description={t('dispute.not_disputable_desc', { defaultValue: 'Solo los viajes completados pueden disputarse.' })}
          action={{ label: t('dispute.back_to_ride', { defaultValue: 'Volver al viaje' }), href: backHref }}
        />
      </main>
    );
  }

  if (submitted) {
    return (
      <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#dcfce7', color: '#16a34a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.75rem', marginBottom: '1rem' }} aria-hidden="true">
          ✓
        </div>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.5rem' }}>{t('dispute.submitted', { defaultValue: 'Disputa enviada' })}</h2>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: '0 0 2rem', maxWidth: 380, lineHeight: 1.5 }}>
          {t('dispute.submitted_description', { defaultValue: 'Tu disputa ha sido registrada. Te notificaremos cuando haya una actualización.' })}
        </p>
        <Link
          href={backHref}
          style={{
            display: 'inline-block', padding: '0.875rem 2.5rem', background: 'var(--primary)', color: '#fff',
            borderRadius: '0.75rem', textDecoration: 'none', fontWeight: 600, fontSize: '0.95rem',
          }}
        >
          {t('ride.done', { defaultValue: 'Listo' })}
        </Link>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
      {header}

      {/* Reason picker */}
      <span style={labelStyle}>{t('dispute.reason_label', { defaultValue: 'Razón de la disputa' })}</span>
      <div style={{ ...cardStyle, overflow: 'hidden', marginBottom: '1.25rem' }}>
        {REASONS.map((r, idx) => (
          <button
            key={r}
            type="button"
            onClick={() => setReason(r)}
            aria-pressed={reason === r}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%',
              padding: '0.8rem 1rem', textAlign: 'left',
              background: reason === r ? 'rgba(255,106,0,0.08)' : 'transparent',
              border: 'none',
              borderTop: idx > 0 ? '1px solid var(--border-light)' : 'none',
              cursor: 'pointer',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 18, height: 18, borderRadius: '50%', flexShrink: 0, boxSizing: 'border-box',
                border: reason === r ? '6px solid var(--primary)' : '2px solid var(--border)',
                background: '#fff',
              }}
            />
            <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: reason === r ? 600 : 400 }}>
              {t(`dispute.reason_${r}`, { defaultValue: REASON_FALLBACK[r] })}
            </span>
          </button>
        ))}
      </div>

      {/* Description */}
      <label htmlFor="dispute-description" style={labelStyle}>
        {t('dispute.description_label', { defaultValue: 'Describe lo que pasó' })}
      </label>
      <textarea
        id="dispute-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t('dispute.description_placeholder', { defaultValue: 'Explica con detalle el problema...' })}
        style={{
          width: '100%', minHeight: 120, padding: '0.75rem 1rem', marginBottom: '1.25rem',
          border: '1px solid var(--border)', borderRadius: '0.75rem',
          fontSize: '0.95rem', background: 'var(--bg-card)', color: 'var(--text-primary)',
          boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', outline: 'none',
        }}
      />

      {/* Evidence photos */}
      <span style={labelStyle}>{t('dispute.evidence_label', { defaultValue: 'Evidencia (opcional)' })}</span>
      <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', margin: '0 0 0.75rem' }}>
        {t('dispute.evidence_hint', { defaultValue: 'Adjunta capturas o fotos como evidencia (máx. {{max}})', max: MAX_EVIDENCE_PHOTOS })}
      </p>
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        {photos.map((p, index) => (
          <div key={p.previewUrl} style={{ position: 'relative', width: 80, height: 80 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.previewUrl}
              alt={t('dispute.evidence_photo', { defaultValue: 'Foto de evidencia {{n}}', n: index + 1 })}
              style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 8, display: 'block' }}
            />
            <button
              type="button"
              onClick={() => removePhoto(index)}
              aria-label={t('common.delete', { defaultValue: 'Eliminar' })}
              style={{
                position: 'absolute', top: -8, right: -8, width: 22, height: 22, borderRadius: '50%',
                background: '#ef4444', color: '#fff', border: 'none', cursor: 'pointer',
                fontSize: 11, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              ✕
            </button>
          </div>
        ))}
        {photos.length < MAX_EVIDENCE_PHOTOS && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={processingPhotos}
            style={{
              width: 80, height: 80, borderRadius: 8, border: '2px dashed var(--border)',
              background: 'var(--bg-card)', color: 'var(--text-tertiary)',
              cursor: processingPhotos ? 'wait' : 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 2, fontSize: '0.65rem',
            }}
          >
            <span style={{ fontSize: '1.25rem' }} aria-hidden="true">📷</span>
            {processingPhotos
              ? t('dispute.processing_photo', { defaultValue: 'Procesando…' })
              : t('dispute.add_photo', { defaultValue: 'Agregar foto' })}
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={onFilesPicked}
          style={{ display: 'none' }}
        />
      </div>

      {/* Visible error (nothing silent) */}
      {formError && (
        <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '0.75rem', padding: '1rem', marginBottom: '1rem' }}>
          <p style={{ color: '#c53030', margin: 0, fontSize: '0.9rem' }}>{formError}</p>
        </div>
      )}

      {/* Submit */}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!reason || !description.trim() || submitting || processingPhotos}
        style={{
          display: 'block', width: '100%', padding: '0.875rem',
          background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '0.75rem',
          fontSize: '0.95rem', fontWeight: 600,
          cursor: submitting ? 'not-allowed' : 'pointer',
          opacity: !reason || !description.trim() || submitting || processingPhotos ? 0.6 : 1,
        }}
      >
        {submitting
          ? t('dispute.submitting', { defaultValue: 'Enviando...' })
          : t('dispute.submit', { defaultValue: 'Enviar disputa' })}
      </button>
    </main>
  );
}
