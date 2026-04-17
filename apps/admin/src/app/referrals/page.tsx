'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gift } from 'lucide-react';
import { referralService } from '@tricigo/api/services/referral';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { Referral, ReferralStatus } from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { formatAdminDate } from '@/lib/formatDate';

const PAGE_SIZE = 20;

type Filter = 'all' | ReferralStatus;

const TABS: StatusTab<Filter>[] = [
  { id: 'all', label: 'Todos' },
  { id: 'pending', label: 'Pendientes', tone: 'warning' },
  { id: 'rewarded', label: 'Premiados', tone: 'success' },
  { id: 'invalidated', label: 'Invalidados', tone: 'danger' },
];

export default function ReferralsPage() {
  const { t: _t } = useTranslation('admin');
  const { showToast } = useToast();

  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortState | null>({ columnId: 'created_at', direction: 'desc' });
  const [stats, setStats] = useState({
    total: 0,
    pending: 0,
    rewarded: 0,
    invalidated: 0,
    total_bonus_paid_cup: 0,
  });
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    action: () => void | Promise<void>;
    title: string;
    message: string;
    variant?: 'danger' | 'warning' | 'default';
  }>({ open: false, action: () => {}, title: '', message: '' });

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const statusFilter = filter === 'all' ? undefined : filter;
      const [result, statsData] = await Promise.all([
        referralService.getAllReferrals(page, PAGE_SIZE, statusFilter),
        referralService.getReferralStats(),
      ]);
      setReferrals(result.data);
      setStats(statsData);
    } catch (err) {
      setReferrals([]);
      setError(err instanceof Error ? err.message : 'No pudimos cargar los referidos.');
    } finally {
      setLoading(false);
    }
  }, [page, filter]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const sortedReferrals = useMemo(() => {
    if (!sort) return referrals;
    const dir = sort.direction === 'asc' ? 1 : -1;
    const key = sort.columnId as keyof Referral;
    return [...referrals].sort((a, b) => {
      const av = a[key] as unknown;
      const bv = b[key] as unknown;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [referrals, sort]);

  const handleReward = (ref: Referral) => {
    setConfirmModal({
      open: true,
      title: 'Premiar referido',
      message: `¿Confirmás premiar a este referido con ${formatCUP(ref.bonus_amount)}?`,
      action: async () => {
        setConfirmModal((prev) => ({ ...prev, open: false }));
        try {
          await referralService.rewardReferral(ref.id);
          showToast('success', 'Referido premiado');
          await fetchData();
        } catch (err) {
          showToast('error', err instanceof Error ? err.message : 'No pudimos premiar el referido.');
        }
      },
    });
  };

  const handleInvalidate = (ref: Referral) => {
    setConfirmModal({
      open: true,
      title: 'Invalidar referido',
      message: 'Esta acción marca el referido como inválido. No se puede deshacer.',
      variant: 'danger',
      action: async () => {
        setConfirmModal((prev) => ({ ...prev, open: false }));
        try {
          await referralService.invalidateReferral(ref.id);
          showToast('success', 'Referido invalidado');
          await fetchData();
        } catch (err) {
          showToast('error', err instanceof Error ? err.message : 'No pudimos invalidar el referido.');
        }
      },
    });
  };

  const conversionRate = stats.total > 0 ? ((stats.rewarded / stats.total) * 100).toFixed(1) : '0';

  const columns: DataColumn<Referral>[] = useMemo(
    () => [
      {
        id: 'code',
        header: 'Código',
        cell: (r) => <span className="font-semibold tracking-wider text-ink">{r.code}</span>,
        primary: true,
        mono: true,
        width: '160px',
      },
      {
        id: 'referrer_id',
        header: 'Referente',
        cell: (r) => `${r.referrer_id.substring(0, 8)}…`,
        mono: true,
        hideBelow: 'md',
        width: '140px',
      },
      {
        id: 'referee_id',
        header: 'Referido',
        cell: (r) => `${r.referee_id.substring(0, 8)}…`,
        mono: true,
        hideBelow: 'md',
        width: '140px',
      },
      {
        id: 'status',
        header: 'Estado',
        cell: (r) => <StatusBadge domain="referral" status={r.status} />,
        sortKey: 'status',
        width: '140px',
      },
      {
        id: 'bonus_amount',
        header: 'Bonus',
        cell: (r) => <span className="font-medium text-ink">{formatCUP(r.bonus_amount)}</span>,
        align: 'right',
        mono: true,
        width: '140px',
        secondary: true,
      },
      {
        id: 'created_at',
        header: 'Fecha',
        cell: (r) => <span className="text-ink-muted">{formatAdminDate(r.created_at)}</span>,
        sortKey: 'created_at',
        hideBelow: 'lg',
        width: '170px',
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          Crecimiento · referidos
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
          Referidos
        </h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          Cada código que trae a alguien nuevo vale oro. Tasa de conversión actual:{' '}
          <span className="font-semibold text-ink">{conversionRate}%</span>.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard label="Total" value={String(stats.total)} loading={loading} />
        <KpiCard label="Pendientes" value={String(stats.pending)} tone="warning" loading={loading} />
        <KpiCard label="Premiados" value={String(stats.rewarded)} tone="success" loading={loading} />
        <KpiCard
          label="Invalidados"
          value={String(stats.invalidated)}
          tone={stats.invalidated > 0 ? 'danger' : 'default'}
          loading={loading}
        />
        <KpiCard
          label="Pagado total"
          value={formatCUP(stats.total_bonus_paid_cup).replace('CUP', '').trim()}
          unit="CUP"
          tone="primary"
          loading={loading}
        />
      </div>

      <FilterBar<Filter>
        sticky
        tabs={TABS}
        activeTab={filter}
        onTabChange={(id) => {
          setFilter(id);
          setPage(0);
        }}
      />

      <DataTable<Referral>
        columns={columns}
        rows={sortedReferrals}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => void fetchData()}
        empty={{
          icon: Gift,
          title: 'Sin referidos',
          body: 'Nadie invitó gente todavía. Cuando suceda, vas a ver la actividad acá.',
        }}
        sort={sort}
        onSortChange={setSort}
        pagination={{ page, pageSize: PAGE_SIZE, hasMore: referrals.length === PAGE_SIZE }}
        onPaginationChange={(next) => setPage(next.page)}
        rowActions={[
          {
            label: 'Premiar',
            onClick: (r) => {
              if (r.status === 'pending') handleReward(r);
            },
          },
          {
            label: 'Invalidar',
            tone: 'danger',
            onClick: (r) => {
              if (r.status === 'pending') handleInvalidate(r);
            },
          },
        ]}
      />

      <AdminConfirmModal
        open={confirmModal.open}
        title={confirmModal.title}
        message={confirmModal.message}
        variant={confirmModal.variant}
        onConfirm={confirmModal.action}
        onCancel={() => setConfirmModal((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
}
