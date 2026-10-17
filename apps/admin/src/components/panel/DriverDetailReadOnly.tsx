'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { CHURN_NEVER_RODE_DAYS, panelReadService, type PanelDriverDetail } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { StatusBadge } from '@/components/data/StatusBadge';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { formatAdminDate } from '@/lib/formatDate';
import { DOC_TYPE_LABEL, VEHICLE_TYPE_LABEL, labelFor, type LabelEntry } from '@/lib/labels';
import { Field } from './Field';
import { ReviewsReadOnly } from './ReviewsReadOnly';

const RISK_LEVEL_LABEL: Record<string, LabelEntry> = {
  high: { key: 'panel_view.risk_high', fallback: 'Alto' },
  medium: { key: 'panel_view.risk_medium', fallback: 'Medio' },
  low: { key: 'panel_view.risk_low', fallback: 'Bajo' },
};

/** A driver as marketing sees it (00663): no wallet, files, selfies, contract, identity or actions. */
export function DriverDetailReadOnly({ driverId }: { driverId: string }) {
  const { t } = useTranslation('admin');
  // undefined while loading, null when there is no such driver.
  const [data, setData] = useState<PanelDriverDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setData(undefined);
    try {
      setData(await panelReadService.getDriverDetail(driverId));
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [driverId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The same back link as the admin driver page.
  const backLink = (
    <Link
      href="/drivers"
      className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
    >
      <ArrowLeft size={14} />
      {t('drivers.back_to_list', { defaultValue: 'Conductores' })}
    </Link>
  );
  const notAvailable = t('panel_view.not_available', { defaultValue: 'No disponible' });

  if (error) return <>{backLink}<AdminErrorBanner message={error} onRetry={() => void load()} /></>;
  if (data === undefined) return <>{backLink}<AdminTableSkeleton rows={6} columns={2} /></>;
  if (data === null) {
    return (
      <>
        {backLink}
        <p className="py-24 text-center text-ink-subtle">{t('drivers.driver_not_found', { defaultValue: 'Conductor no encontrado' })}</p>
      </>
    );
  }

  const { profile: p, documents, scoreEvents, churn, churnUnavailable } = data;
  // acceptance_rate is already a percentage (0-100): the trigger rounds 100 * accepted / offered.
  const pct = (v: number | null) => (v == null ? '—' : `${Math.round(Number(v))}%`);
  const vehicle = [
    p.vehicle_type ? labelFor(t, VEHICLE_TYPE_LABEL, p.vehicle_type) : null,
    p.vehicle_make, p.vehicle_model, p.vehicle_color, p.vehicle_year,
  ].filter(Boolean).join(' · ');
  const churnDays = churn?.days_since_last_ride;

  return (
    <div>
      {backLink}
      <div className="flex flex-col gap-5">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-ink">{p.full_name || '—'}</h1>
          <StatusBadge domain="driver" status={p.status} size="md" />
          {p.phone ? <span className="text-[12.5px] text-ink-muted">{p.phone}</span> : null}
        </header>

        <SectionCard title={t('panel_view.driver_profile', { defaultValue: 'Perfil' })}>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('panel_view.driver_signed_up', { defaultValue: 'Alta' })}>{formatAdminDate(p.created_at)}</Field>
            <Field label={t('panel_view.driver_approved', { defaultValue: 'Aprobado' })}>{formatAdminDate(p.approved_at)}</Field>
            <Field label={t('panel_view.driver_last_seen', { defaultValue: 'Última vez en línea' })}>{formatAdminDate(p.last_heartbeat_at)}</Field>
            {/* As the drivers list: one decimal, '—' while there is no rating. */}
            <Field label={t('panel_view.driver_rating', { defaultValue: 'Calificación' })}>{Number(p.rating_avg) > 0 ? Number(p.rating_avg).toFixed(1) : '—'}</Field>
            <Field label={t('panel_view.driver_rides', { defaultValue: 'Viajes completados' })}>{p.total_rides_completed}</Field>
            <Field label={t('panel_view.driver_acceptance', { defaultValue: 'Tasa de aceptación' })}>{pct(p.acceptance_rate)}</Field>
            <Field label={t('panel_view.driver_area', { defaultValue: 'Municipio' })}>{[p.municipality, p.province].filter(Boolean).join(', ') || '—'}</Field>
            <Field label={t('panel_view.driver_vehicle', { defaultValue: 'Vehículo' })}>{vehicle || '—'}</Field>
            <Field label={t('panel_view.driver_plate', { defaultValue: 'Chapa' })}>{p.plate_number ?? '—'}</Field>
            {p.suspended_at && (
              <Field label={t('panel_view.driver_suspended', { defaultValue: 'Suspendido' })}>
                {formatAdminDate(p.suspended_at)}{p.suspended_reason ? ` · ${p.suspended_reason}` : ''}
              </Field>
            )}
            {churnUnavailable ? (
              <Field label={t('panel_view.driver_churn', { defaultValue: 'Riesgo de abandono' })}>{notAvailable}</Field>
            ) : churn ? (
              <Field label={t('panel_view.driver_churn', { defaultValue: 'Riesgo de abandono' })}>
                {churn.risk_level ? labelFor(t, RISK_LEVEL_LABEL, churn.risk_level) : '—'}
                {churnDays == null
                  ? ''
                  : churnDays >= CHURN_NEVER_RODE_DAYS
                    ? ` · ${t('panel_view.driver_never_rode', { defaultValue: 'Nunca completó un viaje' })}`
                    : ` · ${t('panel_view.driver_days_since', { defaultValue: '{{days}} días sin viajes', days: churnDays })}`}
              </Field>
            ) : null}
          </dl>
        </SectionCard>

        <SectionCard
          title={t('panel_view.driver_documents', { defaultValue: 'Documentos' })}
          description={t('panel_view.driver_documents_hint', { defaultValue: 'Qué subió y si está aprobado. Los archivos solo los abre un administrador.' })}
        >
          {documents.length === 0 ? (
            <p className="text-[13px] text-ink-muted">{t('panel_view.driver_no_documents', { defaultValue: 'No subió documentos.' })}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                  <span className="text-ink">{labelFor(t, DOC_TYPE_LABEL, d.document_type)}</span>
                  <span className="text-ink-muted">
                    {d.is_verified
                      ? t('panel_view.doc_approved', { defaultValue: 'Aprobado' })
                      : d.rejection_reason
                        ? `${t('panel_view.doc_rejected', { defaultValue: 'Rechazado' })} · ${d.rejection_reason}`
                        : t('panel_view.doc_pending', { defaultValue: 'Pendiente' })}
                    {' · '}{formatAdminDate(d.uploaded_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {scoreEvents.length > 0 && (
          <SectionCard title={t('panel_view.driver_score_events', { defaultValue: 'Eventos de puntaje' })}>
            <ul className="flex flex-col gap-1.5">
              {scoreEvents.map((e) => (
                <li key={e.id} className="flex flex-wrap gap-2 text-[13px]">
                  <span className="w-40 shrink-0 text-ink-muted">{formatAdminDate(e.created_at)}</span>
                  <span className="text-ink">{e.event_type.replace(/_/g, ' ')}</span>
                  <span className="text-ink-muted">{e.delta > 0 ? `+${e.delta}` : e.delta}</span>
                </li>
              ))}
            </ul>
          </SectionCard>
        )}

        <ReviewsReadOnly userId={p.user_id} />
      </div>
    </div>
  );
}
