'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ticket, Gift } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import {
  marketingStatsService,
  type PromoCodePerformance,
  type ReferralCodePerformance,
} from '@tricigo/api';
import { formatCUP, getErrorMessage } from '@tricigo/utils';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { formatAdminDate } from '@/lib/formatDate';

type Tab = 'promos' | 'referral';

const num = (n: number) => n.toLocaleString('es-CU');
const cupUnit = (n: number) => formatCUP(n).replace('CUP', '').trim();

/** Numeric-aware client sort (same shape as promotions/referrals pages). */
function sortRows<T>(rows: T[], sort: SortState | null): T[] {
  if (!sort) return rows;
  const dir = sort.direction === 'asc' ? 1 : -1;
  const key = sort.columnId as keyof T;
  return [...rows].sort((a, b) => {
    const av = a[key] as unknown;
    const bv = b[key] as unknown;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
  });
}

function StatusPill({ active, activeLabel, inactiveLabel }: { active: boolean; activeLabel: string; inactiveLabel: string }) {
  return active ? (
    <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
      {activeLabel}
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-muted">
      {inactiveLabel}
    </span>
  );
}

export default function CodePerformancePage() {
  const { t } = useTranslation('admin');

  const [tab, setTab] = useState<Tab>('promos');
  const [promos, setPromos] = useState<PromoCodePerformance[]>([]);
  const [referrers, setReferrers] = useState<ReferralCodePerformance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promoSort, setPromoSort] = useState<SortState | null>({ columnId: 'completed', direction: 'desc' });
  const [refSort, setRefSort] = useState<SortState | null>({ columnId: 'invited', direction: 'desc' });

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, r] = await Promise.all([
        marketingStatsService.getPromoCodePerformance(),
        marketingStatsService.getReferralCodePerformance(),
      ]);
      setPromos(p);
      setReferrers(r);
    } catch (err) {
      setPromos([]);
      setReferrers([]);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const promoTotals = useMemo(
    () => ({
      active: promos.filter((p) => p.is_active).length,
      redemptions: promos.reduce((s, p) => s + p.redemptions, 0),
      completed: promos.reduce((s, p) => s + p.completed, 0),
      discount: promos.reduce((s, p) => s + p.discount_given_cup, 0),
    }),
    [promos],
  );

  const refTotals = useMemo(
    () => ({
      influencers: referrers.length,
      invited: referrers.reduce((s, r) => s + r.invited, 0),
      rewarded: referrers.reduce((s, r) => s + r.rewarded, 0),
      paid: referrers.reduce((s, r) => s + r.bonus_paid_cup, 0),
    }),
    [referrers],
  );

  const sortedPromos = useMemo(() => sortRows(promos, promoSort), [promos, promoSort]);
  const sortedReferrers = useMemo(() => sortRows(referrers, refSort), [referrers, refSort]);

  const discountLabel = useCallback(
    (p: PromoCodePerformance) =>
      p.type === 'fixed_discount' ? `−${num(p.discount_fixed_cup ?? 0)} CUP` : `${p.discount_percent ?? 0}%`,
    [],
  );

  const TABS: StatusTab<Tab>[] = useMemo(
    () => [
      { id: 'promos', label: t('code_performance.tab_promos', { defaultValue: 'Códigos promo' }), count: promos.length },
      { id: 'referral', label: t('code_performance.tab_referral', { defaultValue: 'Códigos de referido' }), count: referrers.length },
    ],
    [t, promos.length, referrers.length],
  );

  const promoColumns: DataColumn<PromoCodePerformance>[] = useMemo(
    () => [
      {
        id: 'code',
        header: t('code_performance.col_code', { defaultValue: 'Código' }),
        cell: (p) => <span className="font-mono font-medium tracking-wider text-ink">{p.code}</span>,
        primary: true,
        mono: true,
        sortKey: 'code',
      },
      {
        id: 'type',
        header: t('code_performance.col_type', { defaultValue: 'Descuento' }),
        cell: (p) => <span className="font-mono text-[12px] text-ink-muted">{discountLabel(p)}</span>,
        hideBelow: 'md',
      },
      {
        id: 'is_active',
        header: t('code_performance.col_status', { defaultValue: 'Estado' }),
        cell: (p) => (
          <StatusPill
            active={p.is_active}
            activeLabel={t('code_performance.status_active', { defaultValue: 'Activa' })}
            inactiveLabel={t('code_performance.status_inactive', { defaultValue: 'Inactiva' })}
          />
        ),
        width: '110px',
      },
      {
        id: 'redemptions',
        header: t('code_performance.col_redemptions', { defaultValue: 'Canjes' }),
        cell: (p) => <span className="font-mono text-ink" data-tabular>{num(p.redemptions)}</span>,
        align: 'right',
        sortKey: 'redemptions',
        width: '96px',
      },
      {
        id: 'completed',
        header: t('code_performance.col_completed', { defaultValue: 'Viajes' }),
        cell: (p) => <span className="font-mono font-semibold text-ink" data-tabular>{num(p.completed)}</span>,
        align: 'right',
        sortKey: 'completed',
        width: '96px',
      },
      {
        id: 'unique_users',
        header: t('code_performance.col_unique_users', { defaultValue: 'Usuarios' }),
        cell: (p) => <span className="font-mono text-ink-muted" data-tabular>{num(p.unique_users)}</span>,
        align: 'right',
        sortKey: 'unique_users',
        width: '96px',
        hideBelow: 'lg',
      },
      {
        id: 'discount_given_cup',
        header: t('code_performance.col_discount', { defaultValue: 'Descuento dado' }),
        cell: (p) => <span className="font-mono text-ink-muted" data-tabular>{formatCUP(p.discount_given_cup)}</span>,
        align: 'right',
        sortKey: 'discount_given_cup',
        hideBelow: 'lg',
      },
      {
        id: 'revenue_cup',
        header: t('code_performance.col_revenue', { defaultValue: 'Ingreso' }),
        cell: (p) => <span className="font-mono text-ink-muted" data-tabular>{formatCUP(p.revenue_cup)}</span>,
        align: 'right',
        sortKey: 'revenue_cup',
        hideBelow: 'xl',
      },
      {
        id: 'valid',
        header: t('code_performance.col_valid', { defaultValue: 'Vigencia' }),
        cell: (p) => (
          <span className="text-[11px] text-ink-muted">
            {p.valid_from ? formatAdminDate(p.valid_from) : '—'}
            <span className="mx-1 text-ink-subtle">→</span>
            {p.valid_until ? formatAdminDate(p.valid_until) : '∞'}
          </span>
        ),
        hideBelow: 'xl',
      },
    ],
    [t, discountLabel],
  );

  const referralColumns: DataColumn<ReferralCodePerformance>[] = useMemo(
    () => [
      {
        id: 'code',
        header: t('code_performance.col_code', { defaultValue: 'Código' }),
        cell: (r) => <span className="font-mono font-medium tracking-wider text-ink">{r.code || '—'}</span>,
        primary: true,
        mono: true,
        sortKey: 'code',
      },
      {
        id: 'referrer_id',
        header: t('code_performance.col_referrer', { defaultValue: 'Referente' }),
        cell: (r) => <span className="font-mono text-ink-muted">{`${r.referrer_id.substring(0, 8)}…`}</span>,
        mono: true,
        hideBelow: 'md',
        width: '150px',
      },
      {
        id: 'invited',
        header: t('code_performance.col_invited', { defaultValue: 'Invitados' }),
        cell: (r) => <span className="font-mono font-semibold text-ink" data-tabular>{num(r.invited)}</span>,
        align: 'right',
        sortKey: 'invited',
        width: '110px',
      },
      {
        id: 'rewarded',
        header: t('code_performance.col_rewarded', { defaultValue: 'Premiados' }),
        cell: (r) => <span className="font-mono text-emerald-600 dark:text-emerald-400" data-tabular>{num(r.rewarded)}</span>,
        align: 'right',
        sortKey: 'rewarded',
        width: '110px',
      },
      {
        id: 'pending',
        header: t('code_performance.col_pending', { defaultValue: 'Pendientes' }),
        cell: (r) => <span className="font-mono text-ink-muted" data-tabular>{num(r.pending)}</span>,
        align: 'right',
        sortKey: 'pending',
        width: '110px',
        hideBelow: 'lg',
      },
      {
        id: 'bonus_paid_cup',
        header: t('code_performance.col_bonus_paid', { defaultValue: 'Bono pagado' }),
        cell: (r) => <span className="font-mono font-medium text-ink" data-tabular>{formatCUP(r.bonus_paid_cup)}</span>,
        align: 'right',
        sortKey: 'bonus_paid_cup',
      },
    ],
    [t],
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          {t('code_performance.page_eyebrow', { defaultValue: 'Crecimiento · medición' })}
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
          {t('code_performance.title', { defaultValue: 'Rendimiento de códigos' })}
        </h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          {tab === 'promos'
            ? t('code_performance.description_promos', {
                defaultValue: 'Qué descuento entregó cada código promo y cuántos viajes generó. Total histórico.',
              })
            : t('code_performance.description_referral', {
                defaultValue: 'Cuánta gente trajo cada influencer con su código de referido y cuánto bono cobró.',
              })}
        </p>
      </div>

      <FilterBar<Tab> sticky tabs={TABS} activeTab={tab} onTabChange={setTab} />

      {tab === 'promos' ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label={t('code_performance.kpi_active_codes', { defaultValue: 'Códigos activos' })} value={num(promoTotals.active)} loading={loading} />
            <KpiCard label={t('code_performance.kpi_redemptions', { defaultValue: 'Canjes' })} value={num(promoTotals.redemptions)} tone="info" loading={loading} />
            <KpiCard label={t('code_performance.kpi_completed', { defaultValue: 'Viajes completados' })} value={num(promoTotals.completed)} tone="success" loading={loading} />
            <KpiCard label={t('code_performance.kpi_discount_given', { defaultValue: 'Descuento entregado' })} value={cupUnit(promoTotals.discount)} unit="CUP" tone="primary" loading={loading} />
          </div>

          <DataTable<PromoCodePerformance>
            columns={promoColumns}
            rows={sortedPromos}
            keyField="id"
            loading={loading}
            error={error}
            onRetry={() => void fetchData()}
            empty={{
              icon: Ticket,
              title: t('code_performance.empty_promos_title', { defaultValue: 'Sin códigos promo' }),
              body: t('code_performance.empty_promos_body', { defaultValue: 'Crea una promoción para que un influencer la difunda y mide su rendimiento aquí.' }),
              action: { label: t('code_performance.go_promotions', { defaultValue: 'Ir a Promociones' }), href: '/promotions' },
            }}
            sort={promoSort}
            onSortChange={setPromoSort}
          />
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label={t('code_performance.kpi_influencers', { defaultValue: 'Referentes' })} value={num(refTotals.influencers)} loading={loading} />
            <KpiCard label={t('code_performance.kpi_invited', { defaultValue: 'Invitados' })} value={num(refTotals.invited)} tone="info" loading={loading} />
            <KpiCard label={t('code_performance.kpi_rewarded', { defaultValue: 'Premiados' })} value={num(refTotals.rewarded)} tone="success" loading={loading} />
            <KpiCard label={t('code_performance.kpi_bonus_paid', { defaultValue: 'Bono pagado' })} value={cupUnit(refTotals.paid)} unit="CUP" tone="primary" loading={loading} />
          </div>

          <DataTable<ReferralCodePerformance>
            columns={referralColumns}
            rows={sortedReferrers}
            keyField="referrer_id"
            loading={loading}
            error={error}
            onRetry={() => void fetchData()}
            empty={{
              icon: Gift,
              title: t('code_performance.empty_referral_title', { defaultValue: 'Sin referidos todavía' }),
              body: t('code_performance.empty_referral_body', { defaultValue: 'Cuando un influencer comparta su código y alguien se registre con él, vas a ver su desempeño aquí.' }),
            }}
            sort={refSort}
            onSortChange={setRefSort}
          />
        </>
      )}
    </div>
  );
}
