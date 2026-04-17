'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, Inbox, Wallet, XCircle } from 'lucide-react';
import { adminService } from '@tricigo/api/services/admin';
import { formatTriciCoin } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useAdminUser } from '@/lib/useAdminUser';
import type {
  LedgerTransaction,
  WalletRedemption,
  WalletRechargeRequest,
} from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { formatAdminDate } from '@/lib/formatDate';
import { exportToCsv } from '@/lib/exportCsv';

const PAGE_SIZE = 20;

type Tab = 'redemptions' | 'recharges' | 'ledger';

type RechargeRow = WalletRechargeRequest & { user_name: string };
type RedemptionRow = WalletRedemption & { driver_name: string };

type WalletStats = {
  total_in_circulation: number;
  pending_redemptions_count: number;
  pending_redemptions_amount: number;
};

const TABS: StatusTab<Tab>[] = [
  { id: 'redemptions', label: 'Retiros pendientes', tone: 'warning' },
  { id: 'recharges', label: 'Recargas pendientes', tone: 'info' },
  { id: 'ledger', label: 'Libro mayor', tone: 'default' },
];

export default function WalletPage() {
  const { userId: adminUserId } = useAdminUser();
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [stats, setStats] = useState<WalletStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('redemptions');
  const [redemptions, setRedemptions] = useState<RedemptionRow[]>([]);
  const [recharges, setRecharges] = useState<RechargeRow[]>([]);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [processing, setProcessing] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    action: () => void | Promise<void>;
    title: string;
    message: string;
    variant?: 'danger' | 'warning' | 'default';
    inputPlaceholder?: string;
  }>({ open: false, action: () => {}, title: '', message: '' });

  const [sortRedemptions, setSortRedemptions] = useState<SortState | null>({
    columnId: 'requested_at',
    direction: 'desc',
  });
  const [sortRecharges, setSortRecharges] = useState<SortState | null>({
    columnId: 'created_at',
    direction: 'desc',
  });
  const [sortTransactions, setSortTransactions] = useState<SortState | null>({
    columnId: 'created_at',
    direction: 'desc',
  });

  // Fetch summary on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await adminService.getWalletStats();
        if (!cancelled) setStats(data);
      } catch {
        // stats are best-effort; do not surface as page error
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchTabData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === 'redemptions') {
        const data = await adminService.getPendingRedemptions(page, PAGE_SIZE);
        setRedemptions(data);
      } else if (tab === 'recharges') {
        const data = await adminService.getPendingRecharges(page, PAGE_SIZE);
        setRecharges(data as RechargeRow[]);
      } else {
        const data = await adminService.getAdminTransactions(page, PAGE_SIZE);
        setTransactions(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos cargar los datos de la billetera.');
    } finally {
      setLoading(false);
    }
  }, [tab, page]);

  useEffect(() => {
    void fetchTabData();
  }, [fetchTabData]);

  const sortRows = useCallback(
    <T,>(rows: T[], sort: SortState | null): T[] => {
      if (!sort) return rows;
      const dir = sort.direction === 'asc' ? 1 : -1;
      const key = sort.columnId as keyof T;
      return [...rows].sort((a, b) => {
        const av = a[key] as unknown;
        const bv = b[key] as unknown;
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
      });
    },
    [],
  );

  const sortedRedemptions = useMemo(
    () => sortRows(redemptions, sortRedemptions),
    [redemptions, sortRedemptions, sortRows],
  );
  const sortedRecharges = useMemo(
    () => sortRows(recharges, sortRecharges),
    [recharges, sortRecharges, sortRows],
  );
  const sortedTransactions = useMemo(
    () => sortRows(transactions, sortTransactions),
    [transactions, sortTransactions, sortRows],
  );

  async function handleRedemption(id: string, action: 'approved' | 'rejected') {
    if (action === 'approved') {
      setConfirmModal({
        open: true,
        title: 'Aprobar retiro',
        message: '¿Confirmás aprobar este retiro? Se va a descontar del saldo del conductor.',
        action: async () => {
          setConfirmModal((prev) => ({ ...prev, open: false }));
          setProcessing(id);
          try {
            await adminService.processRedemption(id, adminUserId, action);
            setRedemptions((prev) => prev.filter((r) => r.id !== id));
            const newStats = await adminService.getWalletStats();
            setStats(newStats);
            showToast('success', 'Retiro aprobado');
          } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'No pudimos procesar el retiro.');
          } finally {
            setProcessing(null);
          }
        },
      });
    } else {
      setRejectReason('');
      setConfirmModal({
        open: true,
        title: 'Rechazar retiro',
        message: 'Contanos el motivo del rechazo (el conductor lo va a ver).',
        variant: 'danger',
        inputPlaceholder: 'Motivo del rechazo',
        action: async () => {
          setConfirmModal((prev) => ({ ...prev, open: false }));
          setProcessing(id);
          try {
            await adminService.processRedemption(id, adminUserId, action, rejectReason);
            setRedemptions((prev) => prev.filter((r) => r.id !== id));
            const newStats = await adminService.getWalletStats();
            setStats(newStats);
            showToast('success', 'Retiro rechazado');
          } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'No pudimos procesar el retiro.');
          } finally {
            setProcessing(null);
          }
        },
      });
    }
  }

  async function handleRecharge(id: string, action: 'approved' | 'rejected') {
    if (action === 'approved') {
      setConfirmModal({
        open: true,
        title: 'Aprobar recarga',
        message: '¿Confirmás aprobar esta recarga? Se va a acreditar al usuario.',
        action: async () => {
          setConfirmModal((prev) => ({ ...prev, open: false }));
          setProcessing(id);
          try {
            await adminService.processRecharge(id, adminUserId, true);
            setRecharges((prev) => prev.filter((r) => r.id !== id));
            showToast('success', 'Recarga aprobada');
          } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'No pudimos procesar la recarga.');
          } finally {
            setProcessing(null);
          }
        },
      });
    } else {
      setRejectReason('');
      setConfirmModal({
        open: true,
        title: 'Rechazar recarga',
        message: 'Contanos el motivo del rechazo (el usuario lo va a ver).',
        variant: 'danger',
        inputPlaceholder: 'Motivo del rechazo',
        action: async () => {
          setConfirmModal((prev) => ({ ...prev, open: false }));
          setProcessing(id);
          try {
            await adminService.processRecharge(id, adminUserId, false, rejectReason);
            setRecharges((prev) => prev.filter((r) => r.id !== id));
            showToast('success', 'Recarga rechazada');
          } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'No pudimos procesar la recarga.');
          } finally {
            setProcessing(null);
          }
        },
      });
    }
  }

  const redemptionColumns: DataColumn<RedemptionRow>[] = useMemo(
    () => [
      {
        id: 'driver_name',
        header: 'Conductor',
        cell: (r) => <span className="font-medium text-ink">{r.driver_name || '—'}</span>,
        primary: true,
      },
      {
        id: 'amount',
        header: 'Monto',
        cell: (r) => <span className="font-medium text-ink">{formatTriciCoin(r.amount)}</span>,
        align: 'right',
        mono: true,
        sortKey: 'amount',
        width: '160px',
        secondary: true,
      },
      {
        id: 'requested_at',
        header: 'Solicitado',
        cell: (r) => <span className="text-ink-muted">{formatAdminDate(r.requested_at)}</span>,
        sortKey: 'requested_at',
        hideBelow: 'lg',
        width: '170px',
      },
    ],
    [],
  );

  const rechargeColumns: DataColumn<RechargeRow>[] = useMemo(
    () => [
      {
        id: 'user_name',
        header: 'Usuario',
        cell: (r) => <span className="font-medium text-ink">{r.user_name || '—'}</span>,
        primary: true,
      },
      {
        id: 'amount',
        header: 'Monto',
        cell: (r) => <span className="font-medium text-ink">{formatTriciCoin(r.amount)}</span>,
        align: 'right',
        mono: true,
        sortKey: 'amount',
        width: '160px',
        secondary: true,
      },
      {
        id: 'created_at',
        header: 'Solicitado',
        cell: (r) => <span className="text-ink-muted">{formatAdminDate(r.created_at)}</span>,
        sortKey: 'created_at',
        hideBelow: 'lg',
        width: '170px',
      },
    ],
    [],
  );

  const ledgerColumns: DataColumn<LedgerTransaction>[] = useMemo(
    () => [
      {
        id: 'description',
        header: 'Descripción',
        cell: (tx) => <span className="font-medium text-ink">{tx.description || '—'}</span>,
        primary: true,
      },
      {
        id: 'type',
        header: 'Tipo',
        cell: (tx) => (
          <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 font-mono text-[10px] text-ink-muted">
            {tx.type}
          </span>
        ),
        width: '130px',
      },
      {
        id: 'reference_id',
        header: 'Referencia',
        cell: (tx) =>
          tx.reference_id ? tx.reference_id.slice(0, 10) + '…' : <span className="text-ink-subtle">—</span>,
        mono: true,
        hideBelow: 'md',
        width: '150px',
      },
      {
        id: 'created_at',
        header: 'Fecha',
        cell: (tx) => <span className="text-ink-muted">{formatAdminDate(tx.created_at)}</span>,
        sortKey: 'created_at',
        hideBelow: 'lg',
        width: '170px',
      },
    ],
    [],
  );

  const handleExport = () => {
    if (tab === 'redemptions') {
      exportToCsv(
        sortedRedemptions as unknown as Record<string, unknown>[],
        [
          { key: 'driver_name', label: 'Conductor' },
          { key: 'amount', label: 'Monto' },
          { key: 'status', label: 'Estado' },
          { key: 'requested_at', label: 'Solicitado' },
        ],
        'wallet-redemptions',
      );
    } else if (tab === 'recharges') {
      exportToCsv(
        sortedRecharges as unknown as Record<string, unknown>[],
        [
          { key: 'user_name', label: 'Usuario' },
          { key: 'amount', label: 'Monto' },
          { key: 'status', label: 'Estado' },
          { key: 'created_at', label: 'Creado' },
        ],
        'wallet-recharges',
      );
    } else {
      exportToCsv(
        sortedTransactions as unknown as Record<string, unknown>[],
        [
          { key: 'description', label: 'Descripción' },
          { key: 'type', label: 'Tipo' },
          { key: 'amount', label: 'Monto' },
          { key: 'reference_id', label: 'Referencia' },
          { key: 'created_at', label: 'Fecha' },
        ],
        'wallet-ledger',
      );
    }
  };

  const listData =
    tab === 'redemptions'
      ? sortedRedemptions
      : tab === 'recharges'
        ? sortedRecharges
        : sortedTransactions;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            Gente · billeteras
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            Billeteras
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            TriciCoin en circulación, retiros, recargas y el libro mayor de movimientos.
          </p>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={listData.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          Exportar CSV
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          label="TriciCoin en circulación"
          value={stats ? formatTriciCoin(stats.total_in_circulation).replace('TRC', '').trim() : '—'}
          unit="TRC"
          tone="primary"
          loading={!stats}
        />
        <KpiCard
          label="Retiros pendientes"
          value={stats ? String(stats.pending_redemptions_count) : '—'}
          tone={stats && stats.pending_redemptions_count > 0 ? 'warning' : 'default'}
          loading={!stats}
        />
        <KpiCard
          label="Monto pendiente"
          value={stats ? formatTriciCoin(stats.pending_redemptions_amount).replace('TRC', '').trim() : '—'}
          unit="TRC"
          loading={!stats}
        />
      </div>

      <FilterBar<Tab>
        sticky
        tabs={TABS}
        activeTab={tab}
        onTabChange={(id) => {
          setTab(id);
          setPage(0);
        }}
      />

      {tab === 'redemptions' && (
        <DataTable<RedemptionRow>
          columns={redemptionColumns}
          rows={sortedRedemptions}
          keyField="id"
          loading={loading}
          error={error}
          onRetry={() => void fetchTabData()}
          empty={{
            icon: CheckCircle2,
            tone: 'success',
            title: 'Sin retiros pendientes',
            body: 'Ningún conductor está esperando aprobación de retiro.',
          }}
          sort={sortRedemptions}
          onSortChange={setSortRedemptions}
          pagination={{ page, pageSize: PAGE_SIZE, hasMore: redemptions.length === PAGE_SIZE }}
          onPaginationChange={(next) => setPage(next.page)}
          rowActions={[
            {
              label: 'Aprobar',
              onClick: (r) => {
                if (processing !== r.id) void handleRedemption(r.id, 'approved');
              },
            },
            {
              label: 'Rechazar',
              tone: 'danger',
              onClick: (r) => {
                if (processing !== r.id) void handleRedemption(r.id, 'rejected');
              },
            },
          ]}
        />
      )}

      {tab === 'recharges' && (
        <DataTable<RechargeRow>
          columns={rechargeColumns}
          rows={sortedRecharges}
          keyField="id"
          loading={loading}
          error={error}
          onRetry={() => void fetchTabData()}
          empty={{
            icon: CheckCircle2,
            tone: 'success',
            title: 'Sin recargas pendientes',
            body: 'Ningún usuario está esperando acreditación.',
          }}
          sort={sortRecharges}
          onSortChange={setSortRecharges}
          pagination={{ page, pageSize: PAGE_SIZE, hasMore: recharges.length === PAGE_SIZE }}
          onPaginationChange={(next) => setPage(next.page)}
          rowActions={[
            {
              label: 'Aprobar',
              onClick: (r) => {
                if (processing !== r.id) void handleRecharge(r.id, 'approved');
              },
            },
            {
              label: 'Rechazar',
              tone: 'danger',
              onClick: (r) => {
                if (processing !== r.id) void handleRecharge(r.id, 'rejected');
              },
            },
          ]}
        />
      )}

      {tab === 'ledger' && (
        <DataTable<LedgerTransaction>
          columns={ledgerColumns}
          rows={sortedTransactions}
          keyField="id"
          loading={loading}
          error={error}
          onRetry={() => void fetchTabData()}
          empty={{
            icon: Inbox,
            title: 'Sin movimientos',
            body: 'Todavía no hay transacciones registradas en el libro mayor.',
          }}
          sort={sortTransactions}
          onSortChange={setSortTransactions}
          pagination={{ page, pageSize: PAGE_SIZE, hasMore: transactions.length === PAGE_SIZE }}
          onPaginationChange={(next) => setPage(next.page)}
        />
      )}

      <AdminConfirmModal
        open={confirmModal.open}
        title={confirmModal.title}
        message={confirmModal.message}
        variant={confirmModal.variant}
        inputValue={rejectReason}
        onInputChange={(val) => setRejectReason(val)}
        inputPlaceholder={confirmModal.inputPlaceholder}
        onConfirm={confirmModal.action}
        onCancel={() => setConfirmModal((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
}
