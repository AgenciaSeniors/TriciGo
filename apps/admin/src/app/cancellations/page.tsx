'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import { getErrorMessage } from '@tricigo/utils';
import { useToast } from '@/components/ui/AdminToast';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { formatAdminDate } from '@/lib/formatDate';
import { useRequestGuard } from '@/hooks/useRequestGuard';

const PAGE_SIZE = 20;

type StatusFilter = 'all' | 'pending' | 'sanctioned' | 'dismissed';

type Review = {
  id: string;
  driver_id: string;
  customer_id: string;
  driver_name: string | null;
  customer_name: string | null;
  signal_type: string;
  risk_score: number;
  signals: { pair_cancel_count?: number; nonexempt_count?: number; exempt_count?: number } | null;
  status: string;
  created_at: string;
};

type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

function riskLevel(score: number): RiskLevel {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

const RISK_CLASS: Record<RiskLevel, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-red-500/10 text-red-600 dark:text-red-400',
  medium: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  low: 'bg-surface-sunken text-ink-muted',
};

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-red-500/10 text-red-600 dark:text-red-400',
  reviewed: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  sanctioned: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  dismissed: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
};

export default function CancellationReviewsPage() {
  const router = useRouter();
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [scanning, setScanning] = useState(false);

  const STATUS_TABS: StatusTab<StatusFilter>[] = useMemo(() => [
    { id: 'pending', label: t('cancellations.filter_pending', { defaultValue: 'Pendientes' }), tone: 'danger' },
    { id: 'sanctioned', label: t('cancellations.filter_sanctioned', { defaultValue: 'Sancionados' }), tone: 'warning' },
    { id: 'dismissed', label: t('cancellations.filter_dismissed', { defaultValue: 'Descartados' }), tone: 'success' },
    { id: 'all', label: t('cancellations.filter_all', { defaultValue: 'Todos' }) },
  ], [t]);

  const riskLabel = useCallback((lvl: RiskLevel): string => {
    switch (lvl) {
      case 'critical': return t('cancellations.risk_critical', { defaultValue: 'Crítico' });
      case 'high': return t('cancellations.risk_high', { defaultValue: 'Alto' });
      case 'medium': return t('cancellations.risk_medium', { defaultValue: 'Medio' });
      case 'low': return t('cancellations.risk_low', { defaultValue: 'Bajo' });
    }
  }, [t]);

  const beginRequest = useRequestGuard();

  const fetchReviews = useCallback(async () => {
    const isLatest = beginRequest();
    setLoading(true);
    setError(null);
    try {
      const data = await adminService.getCancellationReviews(
        statusFilter === 'all' ? undefined : statusFilter,
        page,
        PAGE_SIZE,
      );
      if (!isLatest()) return;
      setReviews(data as unknown as Review[]);
    } catch (err) {
      if (!isLatest()) return;
      setReviews([]);
      setError(getErrorMessage(err));
    } finally {
      if (isLatest()) setLoading(false);
    }
  }, [page, statusFilter, beginRequest]);

  useEffect(() => {
    void fetchReviews();
  }, [fetchReviews]);

  const rescan = useCallback(async () => {
    setScanning(true);
    try {
      const n = await adminService.runCollusionDetection();
      showToast('success', t('cancellations.rescan_done', { defaultValue: `Re-escaneo completo (${n} casos)` }));
      await fetchReviews();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    } finally {
      setScanning(false);
    }
  }, [showToast, t, fetchReviews]);

  const columns: DataColumn<Review>[] = useMemo(
    () => [
      {
        id: 'pair',
        header: t('cancellations.col_pair', { defaultValue: 'Conductor / Pasajero' }),
        cell: (r) => (
          <div className="min-w-0">
            <span className="block truncate font-medium text-ink">{r.driver_name || `${r.driver_id.slice(0, 8)}…`}</span>
            <span className="block truncate text-xs text-ink-muted">{r.customer_name || `${r.customer_id.slice(0, 8)}…`}</span>
          </div>
        ),
        primary: true,
      },
      {
        id: 'cancels',
        header: t('cancellations.col_cancels', { defaultValue: 'Cancelaciones juntos' }),
        cell: (r) => <span className="font-medium text-ink">{r.signals?.pair_cancel_count ?? '—'}</span>,
        width: '150px',
        hideBelow: 'lg',
      },
      {
        id: 'risk',
        header: t('cancellations.col_risk', { defaultValue: 'Riesgo' }),
        cell: (r) => {
          const lvl = riskLevel(r.risk_score);
          return (
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${RISK_CLASS[lvl]}`}>
              {riskLabel(lvl)} · {Math.round(r.risk_score)}
            </span>
          );
        },
        width: '150px',
      },
      {
        id: 'status',
        header: t('cancellations.col_status', { defaultValue: 'Estado' }),
        cell: (r) => (
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CLASS[r.status] ?? 'bg-surface-sunken text-ink-muted'}`}>
            {t(`cancellations.status_${r.status}`, { defaultValue: r.status })}
          </span>
        ),
        width: '150px',
      },
      {
        id: 'created_at',
        header: t('cancellations.col_date', { defaultValue: 'Detectado' }),
        cell: (r) => <span className="text-ink-muted">{formatAdminDate(r.created_at)}</span>,
        hideBelow: 'lg',
        width: '170px',
      },
    ],
    [t, riskLabel],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('cancellations.page_eyebrow', { defaultValue: 'Operación · anti-colusión' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('cancellations.title', { defaultValue: 'Revisión de cancelaciones' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('cancellations.page_description', { defaultValue: 'Pares que cancelan repetido tras encontrarse — posible colusión para evadir la comisión.' })}
          </p>
        </div>
        <button
          type="button"
          disabled={scanning}
          onClick={() => void rescan()}
          className="rounded-lg border border-line bg-surface-elevated px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-sunken disabled:opacity-50"
        >
          {scanning
            ? t('cancellations.rescanning', { defaultValue: 'Escaneando…' })
            : t('cancellations.rescan', { defaultValue: 'Re-escanear' })}
        </button>
      </div>

      <FilterBar<StatusFilter>
        sticky
        tabs={STATUS_TABS}
        activeTab={statusFilter}
        onTabChange={(id) => {
          setStatusFilter(id);
          setPage(0);
        }}
      />

      <DataTable<Review>
        columns={columns}
        rows={reviews}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => {
          setError(null);
          void fetchReviews();
        }}
        empty={{
          icon: ShieldAlert,
          title: t('cancellations.empty_title', { defaultValue: 'Sin casos para revisar' }),
          body: t('cancellations.empty_body', { defaultValue: 'No se detectaron pares sospechosos. Buena señal.' }),
        }}
        rowActions={[
          {
            label: t('cancellations.action_review', { defaultValue: 'Revisar' }),
            onClick: (r) => router.push(`/cancellations/${r.id}`),
          },
        ]}
        pagination={{ page, pageSize: PAGE_SIZE, hasMore: reviews.length === PAGE_SIZE }}
        onPaginationChange={(next) => setPage(next.page)}
      />
    </div>
  );
}
