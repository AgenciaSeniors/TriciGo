'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { panelReadService, type ProductFailures } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { formatAdminDate } from '@/lib/formatDate';

const PERIODS = [7, 30, 90] as const;

/** PostgREST answers PGRST202 while migration 00663 (get_product_failures) is not in the database. */
const FUNCTION_NOT_FOUND = 'PGRST202';

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)} %` : '—';
}

/** Places that do not exist, push reach, app versions and failed payments (00663). */
export function ProductFailuresSection() {
  const { t } = useTranslation('admin');
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const [data, setData] = useState<ProductFailures | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  // Counts the loads: only the latest one may write state, so switching the period quickly never
  // shows the older period's numbers, and nothing is written after the section unmounts.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const mine = ++requestRef.current;
    setError(null);
    setData(null);
    try {
      const result = await panelReadService.getProductFailures(days);
      if (mine === requestRef.current) setData(result);
    } catch (e) {
      if (mine !== requestRef.current) return;
      if ((e as { code?: unknown } | null)?.code === FUNCTION_NOT_FOUND) {
        setHidden(true);
        return;
      }
      setError(getErrorMessage(e));
    }
  }, [days]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  if (hidden) return null;

  const empty = (text: string) => <p className="px-5 pb-5 text-[13px] text-ink-muted">{text}</p>;
  const appName = (app: string) =>
    app === 'driver'
      ? t('product_failures.app_driver', { defaultValue: 'Conductor' })
      : t('product_failures.app_client', { defaultValue: 'Pasajero' });

  return (
    <section className="mb-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-ink">{t('product_failures.title', { defaultValue: 'Fallas del producto' })}</h2>
        <div className="flex gap-1" role="group" aria-label={t('product_failures.period', { defaultValue: 'Período' })}>
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setDays(p)}
              aria-pressed={days === p}
              className={`rounded-full px-3 py-1 text-[12px] font-medium ${days === p ? 'bg-ink text-surface' : 'border border-line bg-surface text-ink hover:bg-surface-sunken'}`}
            >
              {t('product_failures.days', { defaultValue: '{{days}} días', days: p })}
            </button>
          ))}
        </div>
      </div>

      {error ? <AdminErrorBanner message={error} onRetry={() => void load()} /> : null}
      {!data && !error ? <AdminTableSkeleton rows={4} columns={2} /> : null}

      {data && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SectionCard
            bleed
            title={t('product_failures.places_title', { defaultValue: 'Lugares que la gente buscó y no existen' })}
            description={t('product_failures.places_hint', { defaultValue: 'Lo que escribieron como origen o destino de un viaje y la app no tenía.' })}
          >
            {data.placesNotFound.length === 0 ? empty(t('product_failures.places_empty', { defaultValue: 'Nadie buscó un lugar que no exista en este período.' })) : (
              <ul className="flex flex-col gap-1.5 px-5 pb-5">
                {data.placesNotFound.map((p) => (
                  <li key={p.name} className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[13px]">
                    <span className="min-w-0 break-words text-ink">{p.name}</span>
                    <span className="text-ink-muted">
                      {t('product_failures.rides', {
                        count: p.rides,
                        defaultValue: '{{count}} viajes',
                        defaultValue_one: '{{count}} viaje',
                        defaultValue_other: '{{count}} viajes',
                      })}
                      {' · '}
                      {t('product_failures.riders', {
                        count: p.riders,
                        defaultValue: '{{count}} personas',
                        defaultValue_one: '{{count}} persona',
                        defaultValue_other: '{{count}} personas',
                      })}
                      {' · '}
                      {formatAdminDate(p.lastSeen)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            bleed
            title={t('product_failures.push_title', { defaultValue: 'A quién le llegan las notificaciones' })}
            description={t('product_failures.push_hint', { defaultValue: 'Personas activas en el período con un celular que puede recibirlas.' })}
          >
            <dl className="grid grid-cols-2 gap-4 px-5 pb-3 text-[13px]">
              <div>
                <dt className="text-ink-muted">{t('product_failures.push_riders', { defaultValue: 'Pasajeros' })}</dt>
                <dd className="text-xl font-bold text-ink">{share(data.pushReach.ridersReachable, data.pushReach.ridersActive)}</dd>
                <dd className="text-ink-muted">{data.pushReach.ridersReachable} / {data.pushReach.ridersActive}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t('product_failures.push_drivers', { defaultValue: 'Conductores' })}</dt>
                <dd className="text-xl font-bold text-ink">{share(data.pushReach.driversReachable, data.pushReach.driversActive)}</dd>
                <dd className="text-ink-muted">{data.pushReach.driversReachable} / {data.pushReach.driversActive}</dd>
              </div>
            </dl>
            {data.pushOutcomes.length > 0 && (
              <ul className="flex flex-col gap-1 px-5 pb-5 text-[12.5px] text-ink-muted">
                {data.pushOutcomes.map((o) => (
                  <li key={`${o.app}-${o.outcome}`}>
                    {appName(o.app)}
                    {' · '}
                    {t(`product_failures.outcome_${o.outcome}`, { defaultValue: o.outcome })}: {o.users}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard bleed title={t('product_failures.versions_title', { defaultValue: 'Versiones de la app en uso' })}>
            {data.appVersions.length === 0 ? empty(t('product_failures.versions_empty', { defaultValue: 'Se llena cuando salga la versión de la app que reporta aperturas.' })) : (
              <ul className="flex flex-col gap-1.5 px-5 pb-5">
                {data.appVersions.map((v) => (
                  <li key={`${v.app}-${v.version}-${v.platform}`} className="flex justify-between gap-3 text-[13px]">
                    <span className="text-ink">
                      {appName(v.app)} {v.version ?? '—'} · {v.platform ?? '—'}
                    </span>
                    <span className="shrink-0 text-ink-muted">
                      {t('product_failures.installs', {
                        count: v.installs,
                        defaultValue: '{{count}} instalaciones',
                        defaultValue_one: '{{count}} instalación',
                        defaultValue_other: '{{count}} instalaciones',
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard bleed title={t('product_failures.payments_title', { defaultValue: 'Pagos que fallaron' })}>
            {data.failedPayments.length === 0 ? empty(t('product_failures.payments_empty', { defaultValue: 'No falló ningún pago en este período.' })) : (
              <ul className="flex flex-col gap-1.5 px-5 pb-5">
                {data.failedPayments.map((p) => (
                  <li key={p.reason} className="flex justify-between gap-3 text-[13px]">
                    <span className="min-w-0 break-words text-ink">{p.reason}</span>
                    <span className="shrink-0 text-ink-muted">
                      {t('product_failures.payments_count', {
                        count: p.payments,
                        defaultValue: '{{count}} pagos',
                        defaultValue_one: '{{count}} pago',
                        defaultValue_other: '{{count}} pagos',
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      )}
    </section>
  );
}
