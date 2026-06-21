'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import { getErrorMessage } from '@tricigo/utils';
import { useAdminUser } from '@/lib/useAdminUser';
import { useToast } from '@/components/ui/AdminToast';
import { StatusBadge } from '@/components/data/StatusBadge';
import { AdminBreadcrumb } from '@/components/ui/AdminBreadcrumb';
import { formatAdminDate } from '@/lib/formatDate';

type Severity = 'critical' | 'high' | 'medium' | 'low';

const SEVERITY_CLASS: Record<Severity, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-red-500/10 text-red-600 dark:text-red-400',
  medium: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  low: 'bg-surface-sunken text-ink-muted',
};

type UserInfo = { name: string; phone: string } | null;

type IncidentDetail = {
  incident: {
    id: string;
    type: string;
    severity: string;
    status: string;
    ride_id: string | null;
    reported_by: string;
    against_user_id: string | null;
    description: string;
    evidence_urls: string[];
    resolved_by: string | null;
    resolved_at: string | null;
    resolution_notes: string | null;
    created_at: string;
    updated_at: string;
  };
  reporter: UserInfo;
  against: UserInfo;
  resolver: UserInfo;
  ride: { id: string; status: string; pickup_address: string; dropoff_address: string } | null;
  review: {
    id: string;
    rating: number;
    comment: string | null;
    is_visible: boolean;
    created_at: string;
  } | null;
};

export default function IncidentDetailPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const { userId: adminUserId } = useAdminUser();
  const { id } = useParams<{ id: string }>();

  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setMissing(false);
    try {
      const data = await adminService.getIncidentDetail(id);
      if (!data) {
        setMissing(true);
        setDetail(null);
      } else {
        setDetail(data as unknown as IncidentDetail);
      }
    } catch {
      setMissing(true);
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const advanceStatus = useCallback(
    async (next: string, successMsg: string) => {
      if (!detail) return;
      setUpdating(true);
      try {
        await adminService.updateIncidentStatus(detail.incident.id, next, adminUserId);
        setDetail((prev) => (prev ? { ...prev, incident: { ...prev.incident, status: next } } : prev));
        showToast('success', successMsg);
      } catch (err) {
        showToast('error', getErrorMessage(err));
      } finally {
        setUpdating(false);
      }
    },
    [detail, adminUserId, showToast, t],
  );

  const hideReview = useCallback(async () => {
    if (!detail?.review) return;
    const reviewId = detail.review.id;
    setUpdating(true);
    try {
      await adminService.adminHideReview(reviewId, adminUserId);
      await adminService.updateIncidentStatus(detail.incident.id, 'resolved', adminUserId, 'Reseña ocultada');
      setDetail((prev) =>
        prev && prev.review
          ? { ...prev, incident: { ...prev.incident, status: 'resolved' }, review: { ...prev.review, is_visible: false } }
          : prev,
      );
      showToast('success', t('incidents.review_hidden', { defaultValue: 'Reseña ocultada' }));
    } catch (err) {
      showToast('error', getErrorMessage(err));
    } finally {
      setUpdating(false);
    }
  }, [detail, adminUserId, showToast, t]);

  const breadcrumb = (
    <AdminBreadcrumb
      items={[
        { label: t('incidents.title', { defaultValue: 'Incidentes' }), href: '/incidents' },
        { label: t('incidents.detail_title', { defaultValue: 'Detalle del incidente' }) },
      ]}
    />
  );

  if (loading) {
    return (
      <div className="max-w-4xl">
        {breadcrumb}
        <div className="flex items-center justify-center py-24">
          <p className="text-ink-subtle">{t('common.loading', { defaultValue: 'Cargando…' })}</p>
        </div>
      </div>
    );
  }

  if (missing || !detail) {
    return (
      <div className="max-w-4xl">
        {breadcrumb}
        <div className="flex items-center justify-center py-24">
          <p className="text-ink-subtle">{t('incidents.not_found', { defaultValue: 'No encontramos este incidente.' })}</p>
        </div>
      </div>
    );
  }

  const { incident, reporter, against, resolver, ride, review } = detail;
  const sev = ((incident.severity as Severity) ?? 'low');
  const severityLabel: Record<Severity, string> = {
    critical: t('incidents.severity_critical', { defaultValue: 'Crítica' }),
    high: t('incidents.severity_high', { defaultValue: 'Alta' }),
    medium: t('incidents.severity_medium', { defaultValue: 'Media' }),
    low: t('incidents.severity_low', { defaultValue: 'Baja' }),
  };
  const typeLabel = t(`incidents.type_${incident.type}`, { defaultValue: incident.type.replace(/_/g, ' ') });

  const personLine = (info: UserInfo, fallbackId: string | null) => {
    if (info) return `${info.name}${info.phone ? ` (${info.phone})` : ''}`;
    if (fallbackId) return `${fallbackId.slice(0, 8)}…`;
    return '—';
  };

  return (
    <div className="max-w-4xl">
      {breadcrumb}

      {/* Header */}
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('incidents.page_eyebrow', { defaultValue: 'Operación · incidentes' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {typeLabel} <span className="font-mono text-base text-ink-subtle">#{incident.id.slice(0, 8)}</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${SEVERITY_CLASS[sev] ?? SEVERITY_CLASS.low}`}>
              {severityLabel[sev]}
            </span>
            <StatusBadge domain="incident" status={incident.status} />
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          {incident.status === 'open' && (
            <button
              type="button"
              disabled={updating}
              onClick={() => void advanceStatus('investigating', t('incidents.toast_now_investigating', { defaultValue: 'Incidente pasado a investigación' }))}
              className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-50 dark:bg-amber-600 dark:hover:bg-amber-500"
            >
              {t('incidents.action_investigate', { defaultValue: 'Investigar' })}
            </button>
          )}
          {incident.status === 'investigating' && (
            <button
              type="button"
              disabled={updating}
              onClick={() => void advanceStatus('resolved', t('incidents.toast_resolved', { defaultValue: 'Incidente resuelto' }))}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50 dark:bg-green-700 dark:hover:bg-green-600"
            >
              {t('incidents.action_resolve', { defaultValue: 'Resolver' })}
            </button>
          )}
        </div>
      </div>

      {/* Description */}
      <div className="mb-6 rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
        <h2 className="mb-3 text-lg font-bold text-ink">{t('incidents.col_description', { defaultValue: 'Descripción' })}</h2>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">{incident.description}</p>
      </div>

      {/* Reported review (review_abuse) — moderate it */}
      {incident.type === 'review_abuse' && review && (
        <div className="mb-6 rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
          <h2 className="mb-3 text-lg font-bold text-ink">{t('incidents.reported_review', { defaultValue: 'Reseña reportada' })}</h2>
          <div className="mb-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-amber-500">{'★'.repeat(review.rating)}{'☆'.repeat(Math.max(0, 5 - review.rating))}</span>
              <span className="text-sm text-ink-muted">{t('incidents.review_by', { defaultValue: 'por' })} {personLine(against, incident.against_user_id)}</span>
              {!review.is_visible && (
                <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-ink-muted">{t('incidents.review_hidden_badge', { defaultValue: 'Oculta' })}</span>
              )}
            </div>
            {review.comment ? (
              <p className="whitespace-pre-wrap text-sm italic leading-relaxed text-ink-muted">&ldquo;{review.comment}&rdquo;</p>
            ) : (
              <p className="text-sm text-ink-subtle">{t('incidents.review_no_comment', { defaultValue: 'Sin comentario (solo estrellas).' })}</p>
            )}
          </div>
          {incident.status !== 'resolved' && incident.status !== 'dismissed' && (
            <div className="flex gap-2">
              {review.is_visible && (
                <button
                  type="button"
                  disabled={updating}
                  onClick={() => void hideReview()}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  {t('incidents.action_hide_review', { defaultValue: 'Ocultar reseña' })}
                </button>
              )}
              <button
                type="button"
                disabled={updating}
                onClick={() => void advanceStatus('dismissed', t('incidents.toast_review_kept', { defaultValue: 'Reseña mantenida' }))}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50 dark:bg-green-700 dark:hover:bg-green-600"
              >
                {t('incidents.action_keep_review', { defaultValue: 'Mantener' })}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* People */}
        <div className="rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-bold text-ink">{t('incidents.people_section', { defaultValue: 'Involucrados' })}</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-ink-muted">{t('incidents.label_reported_by', { defaultValue: 'Reportado por' })}</dt>
              <dd className="text-sm font-medium text-ink">{personLine(reporter, incident.reported_by)}</dd>
            </div>
            <div>
              <dt className="text-sm text-ink-muted">{t('incidents.label_against', { defaultValue: 'Contra' })}</dt>
              <dd className="text-sm font-medium text-ink">{personLine(against, incident.against_user_id)}</dd>
            </div>
          </dl>
        </div>

        {/* Related ride */}
        <div className="rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-bold text-ink">{t('incidents.ride_section', { defaultValue: 'Viaje relacionado' })}</h2>
          {ride ? (
            <dl className="space-y-3">
              <div>
                <dt className="text-sm text-ink-muted">{t('incidents.label_ride', { defaultValue: 'Viaje' })}</dt>
                <dd className="text-sm font-medium">
                  <Link href={`/rides/${ride.id}`} className="text-primary-500 hover:underline">
                    #{ride.id.slice(0, 8)} · {ride.status}
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="text-sm text-ink-muted">{t('incidents.label_origin', { defaultValue: 'Origen' })}</dt>
                <dd className="text-sm font-medium text-ink">{ride.pickup_address}</dd>
              </div>
              <div>
                <dt className="text-sm text-ink-muted">{t('incidents.label_destination', { defaultValue: 'Destino' })}</dt>
                <dd className="text-sm font-medium text-ink">{ride.dropoff_address}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-ink-subtle">{t('incidents.no_ride', { defaultValue: 'Sin viaje asociado.' })}</p>
          )}
        </div>
      </div>

      {/* Evidence */}
      {incident.evidence_urls.length > 0 && (
        <div className="mb-6 rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-bold text-ink">{t('incidents.evidence_section', { defaultValue: 'Evidencia' })}</h2>
          <ul className="space-y-2">
            {incident.evidence_urls.map((url, i) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm text-primary-500 hover:underline">
                  {t('incidents.evidence_item', { defaultValue: 'Adjunto' })} {i + 1}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Resolution */}
      {incident.status === 'resolved' && (
        <div className="mb-6 rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-bold text-ink">{t('incidents.resolution_section', { defaultValue: 'Resolución' })}</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-ink-muted">{t('incidents.label_resolved_by', { defaultValue: 'Resuelto por' })}</dt>
              <dd className="text-sm font-medium text-ink">{personLine(resolver, incident.resolved_by)}</dd>
            </div>
            {incident.resolved_at && (
              <div>
                <dt className="text-sm text-ink-muted">{t('incidents.label_resolved_at', { defaultValue: 'Fecha de resolución' })}</dt>
                <dd className="text-sm font-medium text-ink">{formatAdminDate(incident.resolved_at)}</dd>
              </div>
            )}
            {incident.resolution_notes && (
              <div>
                <dt className="text-sm text-ink-muted">{t('incidents.label_resolution_notes', { defaultValue: 'Notas' })}</dt>
                <dd className="whitespace-pre-wrap text-sm font-medium text-ink">{incident.resolution_notes}</dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {/* Timestamps */}
      <div className="rounded-xl border border-line bg-surface-elevated p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-bold text-ink">{t('incidents.timestamps_section', { defaultValue: 'Fechas' })}</h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <div>
            <p className="text-sm text-ink-muted">{t('incidents.col_date', { defaultValue: 'Creado' })}</p>
            <p className="text-sm font-medium text-ink">{formatAdminDate(incident.created_at)}</p>
          </div>
          <div>
            <p className="text-sm text-ink-muted">{t('incidents.label_updated', { defaultValue: 'Actualizado' })}</p>
            <p className="text-sm font-medium text-ink">{formatAdminDate(incident.updated_at)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
