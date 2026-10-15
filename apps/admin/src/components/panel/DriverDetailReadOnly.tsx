'use client';

import { useCallback, useEffect, useState } from 'react';
import { panelReadService, type PanelDriverDetail } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { StatusBadge } from '@/components/data/StatusBadge';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { formatAdminDate } from '@/lib/formatDate';
import { Field } from './RideDetailReadOnly';
import { ReviewsReadOnly } from './ReviewsReadOnly';

const VEHICLE_TYPE_KEY: Record<string, { key: string; fallback: string }> = {
  triciclo: { key: 'drivers.type_triciclo', fallback: 'Triciclo' },
  moto: { key: 'drivers.type_moto', fallback: 'Moto' },
  auto: { key: 'drivers.type_auto', fallback: 'Auto' },
  confort: { key: 'drivers.type_confort', fallback: 'Confort' },
};

const DOC_TYPE_KEY: Record<string, { key: string; fallback: string }> = {
  national_id: { key: 'drivers.doc_ci', fallback: 'Carné de identidad' },
  drivers_license: { key: 'drivers.doc_license', fallback: 'Licencia de conducción' },
  vehicle_registration: { key: 'drivers.doc_registration', fallback: 'Matrícula del vehículo' },
  selfie: { key: 'drivers.doc_selfie', fallback: 'Selfie de verificación' },
  vehicle_photo: { key: 'drivers.doc_vehicle_photo', fallback: 'Foto del vehículo' },
  operating_license: { key: 'drivers.doc_operating_license', fallback: 'Licencia operativa' },
};

const RISK_LEVEL_KEY: Record<string, { key: string; fallback: string }> = {
  high: { key: 'panel_view.risk_high', fallback: 'Alto' },
  medium: { key: 'panel_view.risk_medium', fallback: 'Medio' },
  low: { key: 'panel_view.risk_low', fallback: 'Bajo' },
};

/** A driver as marketing sees it (00663): no wallet, files, selfies, contract, identity or actions. */
export function DriverDetailReadOnly({ driverId }: { driverId: string }) {
  const { t } = useTranslation('admin');
  const [data, setData] = useState<PanelDriverDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await panelReadService.getDriverDetail(driverId));
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [driverId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <AdminErrorBanner message={error} onRetry={() => void load()} />;
  if (!data) return <AdminTableSkeleton rows={6} columns={2} />;

  const { profile: p, documents, scoreEvents, churn } = data;
  // acceptance_rate is already a percentage (0-100): the trigger rounds 100 * accepted / offered.
  const pct = (v: number | null) => (v == null ? '—' : `${Math.round(Number(v))} %`);
  const typeLabel = (map: Record<string, { key: string; fallback: string }>, value: string) => {
    const entry = map[value];
    return entry ? t(entry.key, { defaultValue: entry.fallback }) : value;
  };
  const vehicle = [
    p.vehicle_type ? typeLabel(VEHICLE_TYPE_KEY, p.vehicle_type) : null,
    p.vehicle_make, p.vehicle_model, p.vehicle_color, p.vehicle_year,
  ].filter(Boolean).join(' · ');

  return (
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
          <Field label={t('panel_view.driver_rating', { defaultValue: 'Calificación' })}>{p.rating_avg == null ? '—' : Number(p.rating_avg).toFixed(2)}</Field>
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
          {churn && (
            <Field label={t('panel_view.driver_churn', { defaultValue: 'Riesgo de abandono' })}>
              {churn.risk_level ? typeLabel(RISK_LEVEL_KEY, churn.risk_level) : '—'}
              {churn.days_since_last_ride != null
                ? ` · ${t('panel_view.driver_days_since', { defaultValue: '{{days}} días sin viajes', days: churn.days_since_last_ride })}`
                : ''}
            </Field>
          )}
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
                <span className="text-ink">{typeLabel(DOC_TYPE_KEY, d.document_type)}</span>
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
  );
}
