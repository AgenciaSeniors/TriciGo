'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import { getErrorMessage } from '@tricigo/utils';
import { useAdminUser } from '@/lib/useAdminUser';
import { useToast } from '@/components/ui/AdminToast';
import { AdminBreadcrumb } from '@/components/ui/AdminBreadcrumb';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { formatAdminDate } from '@/lib/formatDate';

type Detail = {
  review: {
    id: string;
    driver_id: string;
    customer_id: string;
    signal_type: string;
    risk_score: number;
    signals: { pair_cancel_count?: number; nonexempt_count?: number; exempt_count?: number } | null;
    ride_ids: string[];
    status: string;
    verdict: string | null;
    sanction_type: string | null;
    admin_notes: string | null;
    reviewed_at: string | null;
    created_at: string;
  };
  driver: { name: string; phone: string } | null;
  customer: { name: string; phone: string } | null;
  rides: {
    id: string;
    status: string;
    cancellation_reason_code: string | null;
    canceled_at: string;
    estimated_fare_cup: number;
    driver_gps_status: string | null;
    pickup_address: string;
    dropoff_address: string;
  }[];
};

type Level = 'dismiss' | 'warning' | 'reputation';

export default function CancellationReviewDetailPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const { userId: adminUserId } = useAdminUser();
  const { id } = useParams<{ id: string }>();

  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [pendingLevel, setPendingLevel] = useState<Level | 'reverse' | null>(null);
  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setMissing(false);
    try {
      const data = await adminService.getCancellationReviewDetail(id);
      if (!data) { setMissing(true); setDetail(null); }
      else setDetail(data as unknown as Detail);
    } catch {
      setMissing(true); setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const confirmAction = useCallback(async () => {
    if (!detail || !pendingLevel) return;
    try {
      if (pendingLevel === 'reverse') {
        await adminService.reverseCollusionSanction(detail.review.id, adminUserId);
        showToast('success', t('cancellations.reversed', { defaultValue: 'Sanción revertida' }));
      } else {
        await adminService.applyCollusionSanction(detail.review.id, pendingLevel, notes.trim() || undefined, adminUserId);
        showToast('success', t('cancellations.sanction_done', { defaultValue: 'Caso resuelto' }));
      }
      setPendingLevel(null);
      setNotes('');
      await load();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    }
  }, [detail, pendingLevel, notes, adminUserId, showToast, t, load]);

  const breadcrumb = (
    <AdminBreadcrumb
      items={[
        { label: t('cancellations.title', { defaultValue: 'Revisión de cancelaciones' }), href: '/cancellations' },
        { label: t('cancellations.detail_title', { defaultValue: 'Detalle del caso' }) },
      ]}
    />
  );

  if (loading) {
    return <div className="max-w-4xl">{breadcrumb}<div className="flex items-center justify-center py-24"><p className="text-ink-subtle">{t('common.loading', { defaultValue: 'Cargando…' })}</p></div></div>;
  }
  if (missing || !detail) {
    return <div className="max-w-4xl">{breadcrumb}<div className="flex items-center justify-center py-24"><p className="text-ink-subtle">{t('cancellations.not_found', { defaultValue: 'No encontramos este caso.' })}</p></div></div>;
  }

  const { review, driver, customer, rides } = detail;
  const open = review.status === 'pending' || review.status === 'reviewed';
  const person = (info: { name: string; phone: string } | null, fallback: string) =>
    info ? `${info.name || '—'}${info.phone ? ` (${info.phone})` : ''}` : `${fallback.slice(0, 8)}…`;

  const modalLabel: Record<Level | 'reverse', string> = {
    dismiss: t('cancellations.confirm_dismiss', { defaultValue: 'Descartar (no es colusión)' }),
    warning: t('cancellations.confirm_warning', { defaultValue: 'Enviar aviso al conductor' }),
    reputation: t('cancellations.confirm_reputation', { defaultValue: 'Bajar reputación del conductor' }),
    reverse: t('cancellations.confirm_reverse', { defaultValue: 'Revertir la sanción' }),
  };

  return (
    <div className="max-w-4xl">
      {breadcrumb}

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('cancellations.page_eyebrow', { defaultValue: 'Operación · anti-colusión' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('cancellations.detail_title', { defaultValue: 'Detalle del caso' })} <span className="font-mono text-base text-ink-subtle">#{review.id.slice(0, 8)}</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-red-600 px-2.5 py-0.5 text-[11px] font-medium text-white">
              {t('cancellations.col_risk', { defaultValue: 'Riesgo' })} {Math.round(review.risk_score)}
            </span>
            <span className="inline-flex items-center rounded-full bg-surface-sunken px-2.5 py-0.5 text-[11px] font-medium text-ink-muted">
              {t(`cancellations.status_${review.status}`, { defaultValue: review.status })}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {open && (
            <>
              <button type="button" onClick={() => { setNotes(''); setPendingLevel('dismiss'); }}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700">
                {t('cancellations.action_dismiss', { defaultValue: 'Descartar' })}
              </button>
              <button type="button" onClick={() => { setNotes(''); setPendingLevel('warning'); }}
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-600">
                {t('cancellations.action_warning', { defaultValue: 'Aviso' })}
              </button>
              <button type="button" onClick={() => { setNotes(''); setPendingLevel('reputation'); }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700">
                {t('cancellations.action_reputation', { defaultValue: 'Bajar reputación' })}
              </button>
            </>
          )}
          {review.status === 'sanctioned' && (
            <button type="button" onClick={() => setPendingLevel('reverse')}
              className="rounded-lg border border-line bg-surface-elevated px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-sunken">
              {t('cancellations.action_reverse', { defaultValue: 'Revertir' })}
            </button>
          )}
        </div>
      </div>

      {/* Signals */}
      <div className="mb-6 rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-bold text-ink">{t('cancellations.signals_section', { defaultValue: 'Señales' })}</h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div>
            <p className="text-sm text-ink-muted">{t('cancellations.sig_pair', { defaultValue: 'Cancelaciones juntos' })}</p>
            <p className="text-lg font-semibold text-ink">{review.signals?.pair_cancel_count ?? '—'}</p>
          </div>
          <div>
            <p className="text-sm text-ink-muted">{t('cancellations.sig_nonexempt', { defaultValue: 'No justificadas' })}</p>
            <p className="text-lg font-semibold text-ink">{review.signals?.nonexempt_count ?? '—'}</p>
          </div>
          <div>
            <p className="text-sm text-ink-muted">{t('cancellations.sig_exempt', { defaultValue: 'Con motivo válido' })}</p>
            <p className="text-lg font-semibold text-ink">{review.signals?.exempt_count ?? '—'}</p>
          </div>
          <div>
            <p className="text-sm text-ink-muted">{t('cancellations.col_risk', { defaultValue: 'Riesgo' })}</p>
            <p className="text-lg font-semibold text-ink">{Math.round(review.risk_score)}</p>
          </div>
        </div>
        <p className="mt-4 text-xs text-ink-subtle">
          {t('cancellations.signals_hint', { defaultValue: 'Un motivo válido (avería/seguridad) no penaliza, pero un par que lo repite mucho igual puede ser colusión — decide a criterio.' })}
        </p>
      </div>

      {/* People */}
      <div className="mb-6 rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-bold text-ink">{t('cancellations.people_section', { defaultValue: 'Involucrados' })}</h2>
        <dl className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <dt className="text-sm text-ink-muted">{t('cancellations.label_driver', { defaultValue: 'Conductor (sujeto)' })}</dt>
            <dd className="text-sm font-medium text-ink">{person(driver, review.driver_id)}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-muted">{t('cancellations.label_customer', { defaultValue: 'Pasajero' })}</dt>
            <dd className="text-sm font-medium text-ink">{person(customer, review.customer_id)}</dd>
          </div>
        </dl>
      </div>

      {/* Rides in the pattern */}
      <div className="mb-6 rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-bold text-ink">{t('cancellations.rides_section', { defaultValue: 'Cancelaciones del par' })}</h2>
        {rides.length === 0 ? (
          <p className="text-sm text-ink-subtle">{t('cancellations.no_rides', { defaultValue: 'Sin viajes.' })}</p>
        ) : (
          <ul className="space-y-3">
            {rides.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2 last:border-0">
                <div className="min-w-0">
                  <Link href={`/rides/${r.id}`} className="font-mono text-sm text-primary-500 hover:underline">#{r.id.slice(0, 8)}</Link>
                  <span className="ml-2 text-xs text-ink-muted">
                    {r.cancellation_reason_code
                      ? t(`cancellations.reason_${r.cancellation_reason_code}`, { defaultValue: r.cancellation_reason_code })
                      : t('cancellations.reason_none', { defaultValue: 'sin motivo' })}
                  </span>
                  {r.driver_gps_status && r.driver_gps_status !== 'active' && (
                    <span className="ml-2 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">GPS: {r.driver_gps_status}</span>
                  )}
                </div>
                <span className="text-xs text-ink-subtle">{formatAdminDate(r.canceled_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Resolution */}
      {(review.status === 'sanctioned' || review.status === 'dismissed') && (
        <div className="rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-bold text-ink">{t('cancellations.resolution_section', { defaultValue: 'Resolución' })}</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-ink-muted">{t('cancellations.label_verdict', { defaultValue: 'Veredicto' })}</dt>
              <dd className="text-sm font-medium text-ink">
                {review.sanction_type
                  ? t(`cancellations.sanction_${review.sanction_type}`, { defaultValue: review.sanction_type })
                  : t('cancellations.verdict_just', { defaultValue: 'Sin sanción (legítimo)' })}
              </dd>
            </div>
            {review.reviewed_at && (
              <div>
                <dt className="text-sm text-ink-muted">{t('cancellations.label_reviewed_at', { defaultValue: 'Revisado' })}</dt>
                <dd className="text-sm font-medium text-ink">{formatAdminDate(review.reviewed_at)}</dd>
              </div>
            )}
            {review.admin_notes && (
              <div>
                <dt className="text-sm text-ink-muted">{t('cancellations.label_notes', { defaultValue: 'Notas' })}</dt>
                <dd className="whitespace-pre-wrap text-sm font-medium text-ink">{review.admin_notes}</dd>
              </div>
            )}
          </dl>
        </div>
      )}

      <AdminConfirmModal
        open={pendingLevel !== null}
        variant={pendingLevel === 'dismiss' || pendingLevel === 'reverse' ? 'default' : 'danger'}
        title={pendingLevel ? modalLabel[pendingLevel] : ''}
        message={t('cancellations.confirm_body', { defaultValue: 'Esta acción queda registrada en la auditoría. No mueve dinero.' })}
        confirmLabel={t('common.confirm', { defaultValue: 'Confirmar' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancelar' })}
        inputValue={pendingLevel && pendingLevel !== 'reverse' ? notes : undefined}
        onInputChange={pendingLevel && pendingLevel !== 'reverse' ? setNotes : undefined}
        inputPlaceholder={t('cancellations.notes_placeholder', { defaultValue: 'Nota (opcional)' })}
        onConfirm={confirmAction}
        onCancel={() => setPendingLevel(null)}
      />
    </div>
  );
}
