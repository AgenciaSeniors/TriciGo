'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { panelReadService, type PanelRideDetail } from '@tricigo/api';
import { formatCUP, getErrorMessage } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { StatusBadge } from '@/components/data/StatusBadge';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { formatAdminDate } from '@/lib/formatDate';
import { rideTypeLabel } from '@/lib/rideType';
import { rideCancelSummary } from '@/lib/rideCancel';

const PAYMENT_KEY: Record<string, string> = {
  cash: 'rides.payment_cash',
  tricicoin: 'rides.payment_tricicoin',
  mixed: 'rides.payment_mixed',
  corporate: 'rides.payment_corporate',
  tropipay: 'rides.payment_tropipay',
  stripe: 'rides.payment_tropipay',
};

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="text-[13px] text-ink">{children}</dd>
    </div>
  );
}

/** A ride as marketing sees it (00663): no chat, delivery code or photos, map or actions. */
export function RideDetailReadOnly({ rideId }: { rideId: string }) {
  const { t } = useTranslation('admin');
  const [data, setData] = useState<PanelRideDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await panelReadService.getRideDetail(rideId));
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [rideId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <AdminErrorBanner message={error} onRetry={() => void load()} />;
  if (!data) return <AdminTableSkeleton rows={6} columns={2} />;

  const { ride, transitions, pricing, customerInfo, driverInfo } = data;
  const km = (m: number | null) => (m == null ? '—' : `${(m / 1000).toFixed(1)} km`);
  const min = (s: number | null) => (s == null ? '—' : `${Math.round(s / 60)} min`);
  const paymentKey = PAYMENT_KEY[ride.payment_method];

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-lg font-semibold text-ink">#{ride.id.slice(0, 8)}</h1>
        <StatusBadge domain="ride" status={ride.status} size="md" />
        <span className="text-[12.5px] text-ink-muted">{formatAdminDate(ride.created_at)}</span>
      </header>

      <SectionCard title={t('panel_view.ride_summary', { defaultValue: 'Resumen' })}>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('panel_view.ride_type', { defaultValue: 'Tipo' })}>{rideTypeLabel(t, ride.service_type, ride.ride_mode)}</Field>
          <Field label={t('panel_view.ride_pickup', { defaultValue: 'Origen' })}>{ride.pickup_address}</Field>
          <Field label={t('panel_view.ride_dropoff', { defaultValue: 'Destino' })}>{ride.dropoff_address}</Field>
          <Field label={t('panel_view.ride_estimate', { defaultValue: 'Tarifa estimada' })}>{formatCUP(ride.estimated_fare_cup)}</Field>
          <Field label={t('panel_view.ride_final', { defaultValue: 'Tarifa final' })}>{ride.final_fare_cup == null ? '—' : formatCUP(ride.final_fare_cup)}</Field>
          <Field label={t('panel_view.ride_payment', { defaultValue: 'Pago' })}>{paymentKey ? t(paymentKey) : ride.payment_method}</Field>
          <Field label={t('panel_view.ride_distance', { defaultValue: 'Distancia (estimada / real)' })}>{km(ride.estimated_distance_m)} / {km(ride.actual_distance_m)}</Field>
          <Field label={t('panel_view.ride_duration', { defaultValue: 'Duración (estimada / real)' })}>{min(ride.estimated_duration_s)} / {min(ride.actual_duration_s)}</Field>
          <Field label={t('panel_view.ride_dispatch_round', { defaultValue: 'Ronda de despacho' })}>{ride.dispatch_round}</Field>
          <Field label={t('panel_view.ride_wait', { defaultValue: 'Espera' })}>{min(ride.wait_time_seconds)}</Field>
          {ride.status === 'canceled' && (
            <Field label={t('panel_view.ride_canceled', { defaultValue: 'Cancelación' })}>
              {rideCancelSummary(t, ride.canceled_by_role, ride.cancellation_reason)}
            </Field>
          )}
        </dl>
      </SectionCard>

      <SectionCard title={t('panel_view.ride_people', { defaultValue: 'Pasajero y conductor' })}>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('panel_view.ride_customer', { defaultValue: 'Pasajero' })}>
            {customerInfo ? (
              <Link href={`/users/${ride.customer_id}`} className="text-primary-700 hover:underline dark:text-primary-400">
                {customerInfo.name || '—'}
              </Link>
            ) : '—'}
            {customerInfo?.phone ? <span className="block text-ink-muted">{customerInfo.phone}</span> : null}
          </Field>
          <Field label={t('panel_view.ride_driver', { defaultValue: 'Conductor' })}>
            {driverInfo ? (
              <Link href={`/drivers/${driverInfo.id}`} className="text-primary-700 hover:underline dark:text-primary-400">
                {driverInfo.name || '—'}
              </Link>
            ) : t('panel_view.ride_no_driver', { defaultValue: 'Sin conductor' })}
            {driverInfo?.phone ? <span className="block text-ink-muted">{driverInfo.phone}</span> : null}
          </Field>
        </dl>
      </SectionCard>

      <SectionCard title={t('panel_view.ride_timeline', { defaultValue: 'Cronología' })}>
        {transitions.length === 0 ? (
          <p className="text-[13px] text-ink-muted">{t('panel_view.ride_no_timeline', { defaultValue: 'Sin cambios de estado registrados.' })}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {transitions.map((tr) => (
              <li key={tr.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="w-40 shrink-0 text-ink-muted">{formatAdminDate(tr.created_at)}</span>
                <StatusBadge domain="ride" status={tr.to_status} />
                {tr.reason ? <span className="text-ink-muted">{tr.reason}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </SectionCard>

      {pricing && (
        <SectionCard title={t('panel_view.ride_pricing', { defaultValue: 'Desglose de tarifa' })}>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label={t('panel_view.pricing_base', { defaultValue: 'Base' })}>{formatCUP(pricing.base_fare ?? 0)}</Field>
            <Field label={t('panel_view.pricing_per_km', { defaultValue: 'Por km' })}>{formatCUP(pricing.per_km_rate ?? 0)}</Field>
            <Field label={t('panel_view.pricing_per_min', { defaultValue: 'Por minuto' })}>{formatCUP(pricing.per_minute_rate ?? 0)}</Field>
            <Field label={t('panel_view.pricing_total', { defaultValue: 'Total' })}>{formatCUP(pricing.total ?? 0)}</Field>
          </dl>
        </SectionCard>
      )}
    </div>
  );
}
