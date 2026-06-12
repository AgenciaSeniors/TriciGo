'use client';

// ============================================================
// Web lost-item report — mirror of apps/client/app/ride/lost-item/[rideId].tsx
// (PASS2 PR-J: close the web↔app parity gap for lost & found).
//
// Same fields and submit path as mobile: category picker (8
// LostItemCategory values) + required description, submit via
// lostItemService.reportLostItem (shared @tricigo/api service, photo_urls
// stays [] — mobile doesn't attach photos here either).
//
// Gating mirrors mobile: feature flag `lost_and_found_enabled`, ride must
// be `completed` with a driver, and only one active report per ride.
// Mobile receives driverId via query param; the web resolves it from the
// ride itself (ride.driver_user_id) which is more robust for shared links.
// ============================================================

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import { getSupabaseClient, rideService, lostItemService, useFeatureFlag } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { getErrorMessage } from '@tricigo/utils';
import type { RideWithDriver, LostItem, LostItemCategory } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

// Spanish fallbacks match packages/i18n/src/locales/es/rider.json exactly —
// real translations (es/en/pt) resolve from the shared `rider` namespace.
// Emojis replace the mobile Ionicons (web pages use emoji icons).
const CATEGORIES: { key: LostItemCategory; emoji: string; fallback: string }[] = [
  { key: 'phone', emoji: '📱', fallback: 'Teléfono' },
  { key: 'wallet', emoji: '👛', fallback: 'Billetera' },
  { key: 'bag', emoji: '🎒', fallback: 'Bolso / Mochila' },
  { key: 'clothing', emoji: '👕', fallback: 'Ropa' },
  { key: 'electronics', emoji: '💻', fallback: 'Electrónicos' },
  { key: 'documents', emoji: '📄', fallback: 'Documentos' },
  { key: 'keys', emoji: '🔑', fallback: 'Llaves' },
  { key: 'other', emoji: '❓', fallback: 'Otro' },
];

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.85rem',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: '0.5rem',
};

export default function RideLostItemPage() {
  const { t } = useTranslation('rider');
  const router = useRouter();
  const params = useParams();
  const rideId = params?.id as string | undefined;

  const lostFoundEnabled = useFeatureFlag('lost_and_found_enabled');

  // ── Auth state ──
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // ── Ride + existing report (gating) ──
  const [ride, setRide] = useState<RideWithDriver | null>(null);
  const [existingItem, setExistingItem] = useState<LostItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  // ── Form state ──
  const [category, setCategory] = useState<LostItemCategory | null>(null);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
        const [rideData, itemData] = await Promise.all([
          rideService.getRideWithDriver(rideId),
          lostItemService.getLostItemByRide(rideId).catch(() => null),
        ]);
        if (cancelled) return;
        setRide(rideData);
        setExistingItem(itemData);
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId, rideId]);

  const handleSubmit = async () => {
    if (!category || !description.trim() || !rideId || !userId || !ride?.driver_user_id || submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await lostItemService.reportLostItem({
        ride_id: rideId,
        reporter_id: userId,
        driver_id: ride.driver_user_id,
        description: description.trim(),
        category,
        photo_urls: [],
      });
      setSubmitted(true);
    } catch (err: unknown) {
      // Mirror the mobile duplicate handling (unique report per ride).
      const errObj = err as Record<string, unknown> | null;
      if (typeof errObj?.message === 'string' && (errObj.message.includes('duplicate') || errObj?.code === '23505')) {
        setFormError(t('lost_found.already_reported', { defaultValue: 'Ya reportaste un objeto perdido para este viaje.' }));
      } else {
        setFormError(getErrorMessage(err));
      }
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
      <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{t('lost_found.report_item', { defaultValue: 'Reportar objeto perdido' })}</h1>
    </div>
  );

  if (!lostFoundEnabled) {
    return (
      <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
        {header}
        <WebEmptyState
          icon="🚧"
          title={t('dispute.feature_unavailable', { defaultValue: 'Función no disponible' })}
          description={t('lost_found.feature_unavailable_desc', { defaultValue: 'Los reportes de objetos perdidos no están disponibles por ahora.' })}
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

  // One active report per ride.
  if (existingItem) {
    return (
      <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
        {header}
        <WebEmptyState
          icon="🔍"
          title={t('lost_found.already_reported', { defaultValue: 'Ya existe un reporte activo para este viaje' })}
          description={t('lost_found.already_reported_desc', { defaultValue: 'Puedes ver su estado en el detalle del viaje.' })}
          action={{ label: t('dispute.back_to_ride', { defaultValue: 'Volver al viaje' }), href: backHref }}
        />
      </main>
    );
  }

  // Mobile only surfaces the lost-item CTA for completed rides with a driver.
  if (ride.status !== 'completed' || !ride.driver_user_id) {
    return (
      <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem 1rem', minHeight: '100vh' }}>
        {header}
        <WebEmptyState
          icon="⚠️"
          title={t('lost_found.not_reportable', { defaultValue: 'No se puede reportar un objeto perdido para este viaje' })}
          description={t('lost_found.not_reportable_desc', { defaultValue: 'Solo los viajes completados con conductor asignado admiten reportes.' })}
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
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.5rem' }}>{t('lost_found.submitted', { defaultValue: 'Reporte enviado' })}</h2>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: '0 0 2rem', maxWidth: 380, lineHeight: 1.5 }}>
          {t('lost_found.submitted_desc', { defaultValue: 'Se notificó al conductor. Te avisaremos cuando responda.' })}
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

      {/* Category picker */}
      <span style={labelStyle}>{t('lost_found.category_label', { defaultValue: 'Categoría' })}</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.6rem', marginBottom: '1.5rem' }}>
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setCategory(c.key)}
            aria-pressed={category === c.key}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
              padding: '0.75rem 0.25rem', borderRadius: '0.75rem',
              border: category === c.key ? '2px solid var(--primary)' : '2px solid var(--border)',
              background: category === c.key ? 'rgba(255,106,0,0.08)' : 'var(--bg-card)',
              cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: '1.4rem' }} aria-hidden="true">{c.emoji}</span>
            <span style={{ fontSize: '0.7rem', fontWeight: category === c.key ? 600 : 400, color: category === c.key ? 'var(--primary)' : 'var(--text-secondary)', textAlign: 'center' }}>
              {t(`lost_found.category_${c.key}`, { defaultValue: c.fallback })}
            </span>
          </button>
        ))}
      </div>

      {/* Description */}
      <label htmlFor="lost-item-description" style={labelStyle}>
        {t('lost_found.description_label', { defaultValue: 'Descripción del objeto' })}
      </label>
      <textarea
        id="lost-item-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t('lost_found.description_placeholder', { defaultValue: 'Describe el objeto que perdiste...' })}
        style={{
          width: '100%', minHeight: 120, padding: '0.75rem 1rem', marginBottom: '1.5rem',
          border: '1px solid var(--border)', borderRadius: '0.75rem',
          fontSize: '0.95rem', background: 'var(--bg-card)', color: 'var(--text-primary)',
          boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', outline: 'none',
        }}
      />

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
        disabled={!category || !description.trim() || submitting}
        style={{
          display: 'block', width: '100%', padding: '0.875rem',
          background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '0.75rem',
          fontSize: '0.95rem', fontWeight: 600,
          cursor: submitting ? 'not-allowed' : 'pointer',
          opacity: !category || !description.trim() || submitting ? 0.6 : 1,
        }}
      >
        {submitting
          ? t('lost_found.submitting', { defaultValue: 'Enviando...' })
          : t('lost_found.submit', { defaultValue: 'Enviar reporte' })}
      </button>
    </main>
  );
}
