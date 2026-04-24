'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, TrendingUp } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { createBrowserClient } from '@/lib/supabase-server';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { DataEmptyState } from '@/components/data/DataEmptyState';

type FunnelStep = {
  key: string;
  label: string;
  count: number;
};

export default function FunnelPage() {
  const { t } = useTranslation('admin');
  // Stage labels for the new monotonically-decreasing funnel
  // (see fetchData comment for stage definitions).
  const STEP_LABELS: Record<string, string> = {
    requests: t('funnel.step_requests', { defaultValue: 'Solicitudes creadas' }),
    searches: t('funnel.step_quoted', { defaultValue: 'Con estimado de tarifa' }),
    sessions: t('funnel.step_dispatched', { defaultValue: 'Enviadas a conductor' }),
    accepted: t('funnel.step_accepted', { defaultValue: 'Aceptadas por conductor' }),
    completed: t('funnel.step_completed', { defaultValue: 'Viajes completados' }),
  };

  const [loading, setLoading] = useState(true);
  const [steps, setSteps] = useState<FunnelStep[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = createBrowserClient();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const since = thirtyDaysAgo.toISOString();

      // Funnel stages must be monotonically decreasing for conversion
      // rates to be meaningful. The previous version had two problems:
      //
      //   1. Step 3 filtered `.neq('status', 'draft')` but 'draft' is
      //      NOT a valid ride_status enum value — the comparison fails
      //      silently and returns 0, producing an impossible "step 3 = 0
      //      but step 4 = 10" chart.
      //   2. Step 1 counted DISTINCT customers (cardinality) against
      //      Step 2 counting ride rows, yielding rates like 1775% when
      //      a few customers create many rides.
      //
      // New stages, from widest to narrowest, all counting rides:
      //   1. Solicitudes creadas  = all rides
      //   2. Con estimado         = rides.estimated_fare_cup > 0
      //   3. Enviadas a dispatch  = rides.dispatch_round > 0
      //   4. Aceptadas            = status IN (accepted | en_route | ...)
      //   5. Completadas          = status = 'completed'
      const [allRes, quotedRes, dispatchedRes, acceptedRes, completedRes] = await Promise.all([
        supabase
          .from('rides')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', since),
        supabase
          .from('rides')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', since)
          .gt('estimated_fare_cup', 0),
        supabase
          .from('rides')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', since)
          .gt('dispatch_round', 0),
        supabase
          .from('rides')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', since)
          .in('status', ['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination', 'completed']),
        supabase
          .from('rides')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', since)
          .eq('status', 'completed'),
      ]);

      setSteps([
        { key: 'requests', label: STEP_LABELS.requests!, count: allRes.count ?? 0 },
        { key: 'quoted', label: STEP_LABELS.searches!, count: quotedRes.count ?? 0 },
        { key: 'dispatched', label: STEP_LABELS.sessions!, count: dispatchedRes.count ?? 0 },
        { key: 'accepted', label: STEP_LABELS.accepted!, count: acceptedRes.count ?? 0 },
        { key: 'completed', label: STEP_LABELS.completed!, count: completedRes.count ?? 0 },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('funnel.load_error', { defaultValue: 'No pudimos cargar el embudo.' }));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const maxCount = Math.max(...steps.map((s) => s.count), 1);
  const firstCount = steps[0]?.count ?? 0;

  const FUNNEL_CLASSES = [
    'bg-emerald-500',
    'bg-emerald-400',
    'bg-primary-400',
    'bg-primary-500',
    'bg-primary-600',
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('funnel.page_eyebrow', { defaultValue: 'Crecimiento · conversión' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('funnel.title', { defaultValue: 'Embudo de conversión' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('funnel.page_description', { defaultValue: 'Cómo se convierten las sesiones en viajes reales. Últimos 30 días.' })}
          </p>
        </div>
        <span className="inline-flex items-center rounded-full border border-line bg-surface px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
          {t('funnel.badge_30d', { defaultValue: 'Últimos 30 d' })}
        </span>
      </div>

      {loading && (
        <div className="admin-card p-8">
          <div className="flex flex-col items-center gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 w-full max-w-md animate-pulse rounded-xl bg-surface-sunken" style={{ width: `${100 - i * 15}%` }} />
            ))}
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="admin-card p-8">
          <DataEmptyState
            icon={TrendingUp}
            tone="danger"
            title={t('funnel.load_error_title', { defaultValue: 'No pudimos cargar el embudo' })}
            body={error}
            action={{ label: t('funnel.retry', { defaultValue: 'Reintentar' }), onClick: () => void fetchData() }}
          />
        </div>
      )}

      {!loading && !error && steps.length > 0 && (
        <>
          {/* Funnel visualization */}
          <SectionCard
            eyebrow={t('funnel.section_visual_eyebrow', { defaultValue: 'Visual' })}
            title={t('funnel.section_visual_title', { defaultValue: 'Forma del embudo' })}
            description={t('funnel.section_visual_description', { defaultValue: 'Comparativa proporcional de cada paso.' })}
          >
            <div className="flex flex-col items-center gap-2 py-2">
              {steps.map((step, i) => {
                const prevCount = i > 0 ? steps[i - 1]!.count : 0;
                const rate =
                  i > 0 && prevCount > 0 ? ((step.count / prevCount) * 100).toFixed(1) : null;
                const widthPct = maxCount > 0 ? Math.max((step.count / maxCount) * 100, 12) : 12;
                const colorClass = FUNNEL_CLASSES[i % FUNNEL_CLASSES.length];
                return (
                  <div key={step.key} className="flex w-full flex-col items-center">
                    {rate !== null && (
                      <div className="flex items-center gap-1.5 py-1 font-mono text-[10px] text-ink-muted">
                        <ChevronDown className="h-3 w-3" strokeWidth={2} />
                        <span className="font-semibold">{rate}%</span>
                        <span className="text-ink-subtle">{t('funnel.conversion_label', { defaultValue: 'conversión' })}</span>
                      </div>
                    )}
                    <div
                      className="relative transition-all duration-500"
                      style={{ width: `${widthPct}%`, minWidth: '180px' }}
                    >
                      <div
                        className={`relative overflow-hidden rounded-xl px-4 py-4 text-center text-white ${colorClass}`}
                      >
                        <div className="absolute inset-0 bg-gradient-to-b from-white/15 to-transparent" />
                        <div className="relative">
                          <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] opacity-80">
                            {t('funnel.step_label', { defaultValue: 'Paso' })} {i + 1}
                          </div>
                          <div className="font-editorial text-[28px] leading-none italic" data-tabular>
                            {step.count.toLocaleString('es-CU')}
                          </div>
                          <div className="mt-0.5 text-[12px] font-medium">{step.label}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </SectionCard>

          {/* Summary table */}
          <SectionCard
            eyebrow={t('funnel.section_table_eyebrow', { defaultValue: 'Tabla' })}
            title={t('funnel.section_table_title', { defaultValue: 'Resumen numérico' })}
            description={t('funnel.section_table_description', { defaultValue: 'Tasa paso a paso y tasa total desde la primera etapa.' })}
          >
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-2 pb-2 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-subtle">
                    #
                  </th>
                  <th className="px-2 pb-2 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-subtle">
                    {t('funnel.col_step', { defaultValue: 'Paso' })}
                  </th>
                  <th className="px-2 pb-2 text-right font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-subtle">
                    {t('funnel.col_volume', { defaultValue: 'Volumen' })}
                  </th>
                  <th className="px-2 pb-2 text-right font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-subtle">
                    {t('funnel.col_conversion', { defaultValue: 'Conversión' })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step, i) => {
                  const prevCount = i > 0 ? steps[i - 1]!.count : 0;
                  const rate =
                    i > 0 && prevCount > 0 ? ((step.count / prevCount) * 100).toFixed(1) : null;
                  const totalRate = firstCount > 0 ? ((step.count / firstCount) * 100).toFixed(1) : '0';
                  const rateColor =
                    !rate
                      ? 'text-ink-subtle'
                      : Number(rate) >= 50
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : Number(rate) >= 20
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-red-600 dark:text-red-400';
                  return (
                    <tr key={step.key} className="border-b border-line last:border-b-0">
                      <td className="px-2 py-2.5 font-mono text-[11px] text-ink-subtle">{i + 1}</td>
                      <td className="px-2 py-2.5 font-medium text-ink">{step.label}</td>
                      <td className="px-2 py-2.5 text-right font-mono font-semibold text-ink tabular" data-tabular>
                        {step.count.toLocaleString('es-CU')}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        <span className={`font-mono font-semibold ${rateColor}`} data-tabular>
                          {rate ? `${rate}%` : '—'}
                        </span>
                        {i > 0 && (
                          <span className="ml-2 font-mono text-[10px] text-ink-subtle" data-tabular>
                            ({totalRate}% {t('funnel.total_suffix', { defaultValue: 'total' })})
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </SectionCard>
        </>
      )}

      {!loading && !error && steps.length === 0 && (
        <div className="admin-card p-8">
          <DataEmptyState
            icon={TrendingUp}
            title={t('funnel.empty_title', { defaultValue: 'Sin datos' })}
            body={t('funnel.empty_body', { defaultValue: 'Todavía no hay actividad en los últimos 30 días.' })}
          />
        </div>
      )}
    </div>
  );
}
