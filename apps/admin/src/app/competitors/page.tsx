'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { TrendingDown, Radar } from 'lucide-react';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import { getErrorMessage, formatCUP } from '@tricigo/utils';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { DataEmptyState } from '@/components/data/DataEmptyState';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { formatAdminDate } from '@/lib/formatDate';
import { useRequestGuard } from '@/hooks/useRequestGuard';

type RawSummaryRow = Awaited<ReturnType<typeof adminService.getCompetitorSummary>>[number];
// DataTable keys by a single field; the natural key here is composite, so we
// derive a stable string key per row.
type SummaryRow = RawSummaryRow & { rowKey: string };

type CompetitorFilter = 'all' | 'la_nave' | 'cinco';

const COMPETITOR_LABEL: Record<string, string> = {
  la_nave: 'La Nave',
  cinco: 'CINCO',
};

export default function CompetitorsPage() {
  const { t } = useTranslation('admin');

  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CompetitorFilter>('all');
  const beginRequest = useRequestGuard();

  const load = useCallback(async () => {
    const isLatest = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const data = await adminService.getCompetitorSummary();
      if (!isLatest()) return;
      setRows(data.map((r) => ({ ...r, rowKey: `${r.route_id}:${r.competitor}:${r.competitor_category}` })));
    } catch (err) {
      if (!isLatest()) return;
      // Tolerate the migration not being applied yet: show empty, not a crash.
      setError(getErrorMessage(err));
      setRows([]);
    } finally {
      if (isLatest()) setLoading(false);
    }
  }, [beginRequest]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(
    () => (filter === 'all' ? rows : rows.filter((r) => r.competitor === filter)),
    [rows, filter],
  );

  // KPIs computed from the rows we already have (only rows with a competitor price count).
  const priced = useMemo(() => rows.filter((r) => r.competitor_price_cup != null), [rows]);
  const cheaperCount = priced.filter((r) => r.cheaper_side === 'tricigo').length;
  const cheaperPct = priced.length > 0 ? Math.round((cheaperCount / priced.length) * 100) : null;
  const avgDelta = priced.length > 0
    ? Math.round(priced.reduce((s, r) => s + (r.delta_cup ?? 0), 0) / priced.length)
    : null;
  const latest = rows.reduce<string | null>((acc, r) => (!acc || r.captured_at > acc ? r.captured_at : acc), null);
  const ageHours = latest ? Math.round((Date.now() - new Date(latest).getTime()) / 3.6e6) : null;

  const TABS: StatusTab<CompetitorFilter>[] = useMemo(() => [
    { id: 'all', label: t('competitors.filter_all', { defaultValue: 'Todos' }) },
    { id: 'la_nave', label: 'La Nave' },
    { id: 'cinco', label: 'CINCO' },
  ], [t]);

  const columns: DataColumn<SummaryRow>[] = useMemo(() => [
    {
      id: 'route', header: t('competitors.col_route', { defaultValue: 'Ruta' }), primary: true,
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{r.route_label}</div>
          <div className="text-[11px] text-ink-subtle">{r.province}</div>
        </div>
      ),
    },
    {
      id: 'competitor', header: t('competitors.col_competitor', { defaultValue: 'Competidor' }),
      cell: (r) => (
        <div>
          <div className="text-ink">{COMPETITOR_LABEL[r.competitor] ?? r.competitor}</div>
          <div className="text-[11px] text-ink-subtle">{r.competitor_category}</div>
        </div>
      ),
    },
    {
      id: 'them', header: t('competitors.col_them', { defaultValue: 'Ellos' }), mono: true,
      cell: (r) => (r.competitor_price_cup != null
        ? formatCUP(r.competitor_price_cup)
        : <span className="text-ink-subtle">{t('competitors.na', { defaultValue: 'n/d' })}</span>),
    },
    {
      id: 'us', header: t('competitors.col_us', { defaultValue: 'TriciGo' }), mono: true,
      cell: (r) => formatCUP(r.tricigo_price_cup),
    },
    {
      id: 'delta', header: t('competitors.col_delta', { defaultValue: 'Δ' }), mono: true, hideBelow: 'md',
      cell: (r) => {
        if (r.competitor_price_cup == null || r.delta_cup == null) return <span className="text-ink-subtle">—</span>;
        const cheaper = r.cheaper_side === 'tricigo';
        const tie = r.cheaper_side === 'tie';
        const cls = tie ? 'text-ink-muted' : cheaper ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
        const sign = r.delta_cup > 0 ? '+' : '';
        return <span className={cls}>{sign}{formatCUP(r.delta_cup)}</span>;
      },
    },
    {
      id: 'captured', header: t('competitors.col_captured', { defaultValue: 'Capturado' }), secondary: true, hideBelow: 'lg',
      cell: (r) => <span className="text-ink-muted">{formatAdminDate(r.captured_at)}</span>,
    },
  ], [t]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 px-4 py-6 sm:px-6">
      <header>
        <p className="mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-ink-subtle">
          {t('competitors.eyebrow', { defaultValue: 'Inteligencia de precios' })}
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-tight text-ink">
          {t('competitors.title', { defaultValue: 'Precios de la competencia' })}
        </h1>
        <p className="mt-1 text-[12.5px] text-ink-muted">
          {t('competitors.subtitle', {
            defaultValue: 'La Nave y CINCO cotizados 24/7 sobre una canasta fija, comparados con el precio de TriciGo en el mismo instante.',
          })}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard
          label={t('competitors.kpi_cheaper', { defaultValue: 'Rutas donde somos más baratos' })}
          value={cheaperPct != null ? `${cheaperPct}%` : '—'}
          tone="success"
          icon={TrendingDown}
          hint={priced.length > 0 ? t('competitors.kpi_cheaper_hint', { defaultValue: `${cheaperCount} de ${priced.length}`, count: priced.length }) : undefined}
          loading={loading}
        />
        <KpiCard
          label={t('competitors.kpi_avg_delta', { defaultValue: 'Δ promedio (ellos − nosotros)' })}
          value={avgDelta != null ? formatCUP(avgDelta) : '—'}
          tone={avgDelta != null && avgDelta >= 0 ? 'success' : 'warning'}
          loading={loading}
        />
        <KpiCard
          label={t('competitors.kpi_freshness', { defaultValue: 'Antigüedad del último dato' })}
          value={ageHours != null ? `${ageHours}` : '—'}
          unit={ageHours != null ? t('competitors.hours', { defaultValue: 'h' }) : undefined}
          tone={ageHours != null && ageHours <= 2 ? 'success' : 'warning'}
          loading={loading}
        />
      </div>

      <FilterBar<CompetitorFilter> tabs={TABS} activeTab={filter} onTabChange={setFilter} />

      <DataTable<SummaryRow>
        columns={columns}
        rows={filtered}
        keyField="rowKey"
        loading={loading}
        error={error}
        onRetry={load}
        empty={{
          icon: Radar,
          tone: 'info',
          title: t('competitors.empty_title', { defaultValue: 'Sin cotizaciones todavía' }),
          body: t('competitors.empty_body', {
            defaultValue: 'El observatorio aún no capturó precios. Verificá que la sesión del competidor esté depositada y el rastreo activo.',
          }),
        }}
      />
    </div>
  );
}
