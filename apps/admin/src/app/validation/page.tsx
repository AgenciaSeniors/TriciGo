'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Compass, Gauge, Target } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { createBrowserClient } from '@/lib/supabase-server';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { SectionCard } from '@/components/dashboard/SectionCard';

type AcceptRateRow = {
  profit_level: string | null;
  total: number;
  accepted: number;
  rejected: number;
  accept_rate: number;
};

type NavRateRow = {
  total: number;
  triggered: number;
  cancelled: number;
  follow_rate: number;
};

type OverrideRow = {
  driver_id: string;
  total_overrides: number;
  reject_count: number;
  nav_cancel_count: number;
};

const DAYS_OPTIONS = [
  { label: '7d', value: 7 },
  { label: '14d', value: 14 },
  { label: '30d', value: 30 },
];

function rateTone(rate: number, green: number, amber: number): 'success' | 'warning' | 'danger' {
  if (rate >= green) return 'success';
  if (rate >= amber) return 'warning';
  return 'danger';
}

export default function ValidationPage() {
  const { t } = useTranslation('admin');
  const [daysBack, setDaysBack] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [acceptRates, setAcceptRates] = useState<AcceptRateRow[]>([]);
  const [navRate, setNavRate] = useState<NavRateRow | null>(null);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    const supabase = createBrowserClient();
    try {
      const [acceptRes, navRes, overrideRes] = await Promise.all([
        supabase.rpc('get_auto_accept_rate', { p_days_back: daysBack }),
        supabase.rpc('get_auto_nav_rate', { p_days_back: daysBack }),
        supabase.rpc('get_override_frequency', { p_days_back: daysBack, p_limit: 20 }),
      ]);
      if (acceptRes.error) throw acceptRes.error;
      if (navRes.error) throw navRes.error;
      if (overrideRes.error) throw overrideRes.error;

      setAcceptRates(acceptRes.data ?? []);
      const navRows = navRes.data as NavRateRow[] | null;
      setNavRate(navRows && navRows.length > 0 ? navRows[0] ?? null : null);
      setOverrides(overrideRes.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('validation.load_error', { defaultValue: 'No pudimos cargar la validación.' }));
    } finally {
      setLoading(false);
    }
  }, [daysBack, t]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const followRate = navRate?.follow_rate ?? 0;

  const acceptColumns: DataColumn<AcceptRateRow>[] = useMemo(
    () => [
      {
        id: 'profit_level',
        header: t('validation.col_profit_level', { defaultValue: 'Nivel de ganancia' }),
        cell: (r) => (
          <span className="font-medium text-ink">
            {r.profit_level ?? t('validation.no_data_label', { defaultValue: 'Sin dato' })}
          </span>
        ),
        primary: true,
      },
      { id: 'total', header: t('validation.col_total', { defaultValue: 'Total' }), cell: (r) => r.total, align: 'right', mono: true, width: '100px' },
      {
        id: 'accepted',
        header: t('validation.col_accepted', { defaultValue: 'Aceptados' }),
        cell: (r) => r.accepted,
        align: 'right',
        mono: true,
        hideBelow: 'md',
        width: '110px',
      },
      {
        id: 'rejected',
        header: t('validation.col_rejected', { defaultValue: 'Rechazados' }),
        cell: (r) => r.rejected,
        align: 'right',
        mono: true,
        hideBelow: 'md',
        width: '110px',
      },
      {
        id: 'accept_rate',
        header: t('validation.col_rate', { defaultValue: 'Tasa' }),
        cell: (r) => {
          const tone = rateTone(r.accept_rate, 85, 70);
          const cls =
            tone === 'success'
              ? 'text-emerald-600 dark:text-emerald-400'
              : tone === 'warning'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-red-600 dark:text-red-400';
          return <span className={`font-semibold ${cls}`}>{r.accept_rate}%</span>;
        },
        align: 'right',
        mono: true,
        width: '110px',
        secondary: true,
      },
    ],
    [t],
  );

  const overrideColumns: DataColumn<OverrideRow>[] = useMemo(
    () => [
      {
        id: 'driver_id',
        header: t('validation.col_driver', { defaultValue: 'Conductor' }),
        cell: (r) => `${r.driver_id.slice(0, 8)}…`,
        mono: true,
        primary: true,
      },
      {
        id: 'total_overrides',
        header: t('validation.col_total_overrides', { defaultValue: 'Total overrides' }),
        cell: (r) => (
          <span className={r.total_overrides > 10 ? 'font-semibold text-amber-600 dark:text-amber-400' : ''}>
            {r.total_overrides}
          </span>
        ),
        align: 'right',
        mono: true,
        secondary: true,
        width: '140px',
      },
      {
        id: 'reject_count',
        header: t('validation.col_rejects', { defaultValue: 'Rechazos' }),
        cell: (r) => r.reject_count,
        align: 'right',
        mono: true,
        hideBelow: 'md',
        width: '110px',
      },
      {
        id: 'nav_cancel_count',
        header: t('validation.col_nav_cancels', { defaultValue: 'Cancel. nav.' }),
        cell: (r) => r.nav_cancel_count,
        align: 'right',
        mono: true,
        hideBelow: 'md',
        width: '120px',
      },
    ],
    [t],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('validation.page_eyebrow', { defaultValue: 'Operación · validación' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('validation.title', { defaultValue: 'Validación automática' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('validation.page_description', { defaultValue: 'Qué tan bien el motor auto-acepta y auto-navega los viajes en las últimas semanas.' })}
          </p>
        </div>
        <div className="flex gap-1 rounded-full border border-line bg-surface p-0.5">
          {DAYS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setDaysBack(opt.value)}
              aria-pressed={daysBack === opt.value}
              className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                daysBack === opt.value
                  ? 'bg-surface-elevated text-ink shadow-elev-1'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <KpiCard
          className="lg:col-span-1"
          variant="hero"
          tone={rateTone(followRate, 70, 50)}
          icon={Compass}
          label={t('validation.kpi_follow_rate_label', { defaultValue: 'Tasa de seguimiento de navegación' })}
          value={navRate ? `${followRate}%` : '—'}
          hint={
            navRate
              ? `${navRate.triggered} ${t('validation.kpi_triggered_suffix', { defaultValue: 'activaciones' })} · ${navRate.cancelled} ${t('validation.kpi_cancelled_suffix', { defaultValue: 'canceladas' })}`
              : t('validation.kpi_no_data_hint', { defaultValue: 'Sin datos en este período' })
          }
          loading={loading}
        />

        <SectionCard
          className="lg:col-span-2"
          eyebrow={t('validation.section_engine_eyebrow', { defaultValue: 'Motor automático' })}
          title={t('validation.section_engine_title', { defaultValue: 'Auto-aceptación por nivel de ganancia' })}
          description={t('validation.section_engine_description', { defaultValue: 'Cuántas ofertas se aceptan sin intervención humana.' })}
        >
          <DataTable<AcceptRateRow>
            columns={acceptColumns}
            rows={acceptRates}
            keyField="profit_level"
            loading={loading}
            error={error}
            onRetry={() => void fetchAll()}
            empty={{
              icon: Gauge,
              title: t('validation.empty_accept_title', { defaultValue: 'Sin datos de auto-aceptación' }),
              body: t('validation.empty_accept_body', { defaultValue: 'No hay actividad registrada en el período seleccionado.' }),
            }}
          />
        </SectionCard>
      </div>

      <SectionCard
        eyebrow={t('validation.section_overrides_eyebrow', { defaultValue: 'Top overriders' })}
        title={t('validation.section_overrides_title', { defaultValue: 'Conductores que más intervienen' })}
        description={t('validation.section_overrides_description', { defaultValue: 'Quiénes rechazan más ofertas o cancelan más veces la navegación asistida.' })}
      >
        <DataTable<OverrideRow>
          columns={overrideColumns}
          rows={overrides}
          keyField="driver_id"
          loading={loading}
          error={error}
          onRetry={() => void fetchAll()}
          empty={{
            icon: Target,
            title: t('validation.empty_overrides_title', { defaultValue: 'Sin overrides en este período' }),
            body: t('validation.empty_overrides_body', { defaultValue: 'Nadie intervino los automatismos — el motor está corriendo solo.' }),
          }}
        />
      </SectionCard>
    </div>
  );
}
