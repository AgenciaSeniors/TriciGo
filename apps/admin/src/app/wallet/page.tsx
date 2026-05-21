'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, Inbox } from 'lucide-react';
import { WalletV2BonusPushButton } from '@/components/wallet/WalletV2BonusPushButton';
import { adminService } from '@tricigo/api/services/admin';
import { formatTriciCoin } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useAdminUser } from '@/lib/useAdminUser';
import type {
  LedgerTransaction,
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

type Tab = 'recharges' | 'ledger';

type RechargeRow = WalletRechargeRequest & { user_name: string };

type WalletStats = {
  total_in_circulation: number;
  pending_redemptions_count: number;
  pending_redemptions_amount: number;
};

export default function WalletPage() {
  const { userId: adminUserId } = useAdminUser();
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [stats, setStats] = useState<WalletStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('recharges');
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

  const [sortRecharges, setSortRecharges] = useState<SortState | null>({
    columnId: 'created_at',
    direction: 'desc',
  });
  const [sortTransactions, setSortTransactions] = useState<SortState | null>({
    columnId: 'created_at',
    direction: 'desc',
  });

  const TABS: StatusTab<Tab>[] = useMemo(() => [
    { id: 'recharges', label: t('wallet_admin.tab_recharges', { defaultValue: 'Recargas pendientes' }), tone: 'info' },
    { id: 'ledger', label: t('wallet_admin.tab_ledger', { defaultValue: 'Libro mayor' }), tone: 'default' },
  ], [t]);

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
      if (tab === 'recharges') {
        const data = await adminService.getPendingRecharges(page, PAGE_SIZE);
        setRecharges(data as RechargeRow[]);
      } else {
        const data = await adminService.getAdminTransactions(page, PAGE_SIZE);
        setTransactions(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('wallet_admin.load_error', { defaultValue: 'No pudimos cargar los datos de la billetera.' }));
    } finally {
      setLoading(false);
    }
  }, [tab, page, t]);

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

  const sortedRecharges = useMemo(
    () => sortRows(recharges, sortRecharges),
    [recharges, sortRecharges, sortRows],
  );
  const sortedTransactions = useMemo(
    () => sortRows(transactions, sortTransactions),
    [transactions, sortTransactions, sortRows],
  );

  async function handleRecharge(id: string, action: 'approved' | 'rejected') {
    if (action === 'approved') {
      setConfirmModal({
        open: true,
        title: t('wallet_admin.approve_recharge_title', { defaultValue: 'Aprobar recarga' }),
        message: t('wallet_admin.approve_recharge_msg', { defaultValue: '¿Confirmás aprobar esta recarga? Se va a acreditar al usuario.' }),
        action: async () => {
          setConfirmModal((prev) => ({ ...prev, open: false }));
          setProcessing(id);
          try {
            await adminService.processRecharge(id, adminUserId, true);
            setRecharges((prev) => prev.filter((r) => r.id !== id));
            showToast('success', t('wallet_admin.toast_recharge_approved', { defaultValue: 'Recarga aprobada' }));
          } catch (err) {
            showToast('error', err instanceof Error ? err.message : t('wallet_admin.recharge_error', { defaultValue: 'No pudimos procesar la recarga.' }));
          } finally {
            setProcessing(null);
          }
        },
      });
    } else {
      setRejectReason('');
      setConfirmModal({
        open: true,
        title: t('wallet_admin.reject_recharge_title', { defaultValue: 'Rechazar recarga' }),
        message: t('wallet_admin.reject_recharge_msg', { defaultValue: 'Contanos el motivo del rechazo (el usuario lo va a ver).' }),
        variant: 'danger',
        inputPlaceholder: t('wallet_admin.reject_reason_placeholder', { defaultValue: 'Motivo del rechazo' }),
        action: async () => {
          setConfirmModal((prev) => ({ ...prev, open: false }));
          setProcessing(id);
          try {
            await adminService.processRecharge(id, adminUserId, false, rejectReason);
            setRecharges((prev) => prev.filter((r) => r.id !== id));
            showToast('success', t('wallet_admin.toast_recharge_rejected', { defaultValue: 'Recarga rechazada' }));
          } catch (err) {
            showToast('error', err instanceof Error ? err.message : t('wallet_admin.recharge_error', { defaultValue: 'No pudimos procesar la recarga.' }));
          } finally {
            setProcessing(null);
          }
        },
      });
    }
  }

  const rechargeColumns: DataColumn<RechargeRow>[] = useMemo(
    () => [
      {
        id: 'user_name',
        header: t('wallet_admin.col_user', { defaultValue: 'Usuario' }),
        cell: (r) => <span className="font-medium text-ink">{r.user_name || '—'}</span>,
        primary: true,
      },
      {
        id: 'amount',
        header: t('wallet_admin.col_amount', { defaultValue: 'Monto' }),
        cell: (r) => <span className="font-medium text-ink">{formatTriciCoin(r.amount)}</span>,
        align: 'right',
        mono: true,
        sortKey: 'amount',
        width: '160px',
        secondary: true,
      },
      {
        id: 'created_at',
        header: t('wallet_admin.col_requested', { defaultValue: 'Solicitado' }),
        cell: (r) => <span className="text-ink-muted">{formatAdminDate(r.created_at)}</span>,
        sortKey: 'created_at',
        hideBelow: 'lg',
        width: '170px',
      },
    ],
    [t],
  );

  const ledgerColumns: DataColumn<LedgerTransaction>[] = useMemo(
    () => [
      {
        id: 'description',
        header: t('wallet_admin.col_description', { defaultValue: 'Descripción' }),
        cell: (tx) => <span className="font-medium text-ink">{tx.description || '—'}</span>,
        primary: true,
      },
      {
        id: 'type',
        header: t('wallet_admin.col_type', { defaultValue: 'Tipo' }),
        cell: (tx) => (
          <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 font-mono text-[10px] text-ink-muted">
            {tx.type}
          </span>
        ),
        width: '130px',
      },
      {
        id: 'reference_id',
        header: t('wallet_admin.col_reference', { defaultValue: 'Referencia' }),
        cell: (tx) =>
          tx.reference_id ? tx.reference_id.slice(0, 10) + '…' : <span className="text-ink-subtle">—</span>,
        mono: true,
        hideBelow: 'md',
        width: '150px',
      },
      {
        id: 'created_at',
        header: t('wallet_admin.col_date', { defaultValue: 'Fecha' }),
        cell: (tx) => <span className="text-ink-muted">{formatAdminDate(tx.created_at)}</span>,
        sortKey: 'created_at',
        hideBelow: 'lg',
        width: '170px',
      },
    ],
    [t],
  );

  const handleExport = () => {
    if (tab === 'recharges') {
      exportToCsv(
        sortedRecharges as unknown as Record<string, unknown>[],
        [
          { key: 'user_name', label: t('wallet_admin.col_user', { defaultValue: 'Usuario' }) },
          { key: 'amount', label: t('wallet_admin.col_amount', { defaultValue: 'Monto' }) },
          { key: 'status', label: t('wallet_admin.col_status', { defaultValue: 'Estado' }) },
          { key: 'created_at', label: t('wallet_admin.col_created', { defaultValue: 'Creado' }) },
        ],
        'wallet-recharges',
      );
    } else {
      exportToCsv(
        sortedTransactions as unknown as Record<string, unknown>[],
        [
          { key: 'description', label: t('wallet_admin.col_description', { defaultValue: 'Descripción' }) },
          { key: 'type', label: t('wallet_admin.col_type', { defaultValue: 'Tipo' }) },
          { key: 'amount', label: t('wallet_admin.col_amount', { defaultValue: 'Monto' }) },
          { key: 'reference_id', label: t('wallet_admin.col_reference', { defaultValue: 'Referencia' }) },
          { key: 'created_at', label: t('wallet_admin.col_date', { defaultValue: 'Fecha' }) },
        ],
        'wallet-ledger',
      );
    }
  };

  const listData = tab === 'recharges' ? sortedRecharges : sortedTransactions;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('wallet_admin.page_eyebrow', { defaultValue: 'Gente · billeteras' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('wallet_admin.title', { defaultValue: 'Billeteras' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('wallet_admin.page_description', { defaultValue: 'TriciCoin en circulación, recargas y el libro mayor de movimientos.' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <WalletV2BonusPushButton />
          <button
            type="button"
            onClick={handleExport}
            disabled={listData.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            {t('wallet_admin.export_csv', { defaultValue: 'Exportar CSV' })}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        <KpiCard
          label={t('wallet_admin.kpi_circulation', { defaultValue: 'TriciCoin en circulación' })}
          value={stats ? formatTriciCoin(stats.total_in_circulation).replace('TRC', '').trim() : '—'}
          unit="TRC"
          tone="primary"
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
            title: t('wallet_admin.empty_recharges_title', { defaultValue: 'Sin recargas pendientes' }),
            body: t('wallet_admin.empty_recharges_body', { defaultValue: 'Ningún usuario está esperando acreditación.' }),
          }}
          sort={sortRecharges}
          onSortChange={setSortRecharges}
          pagination={{ page, pageSize: PAGE_SIZE, hasMore: recharges.length === PAGE_SIZE }}
          onPaginationChange={(next) => setPage(next.page)}
          rowActions={[
            {
              label: t('wallet_admin.action_approve', { defaultValue: 'Aprobar' }),
              onClick: (r) => {
                if (processing !== r.id) void handleRecharge(r.id, 'approved');
              },
            },
            {
              label: t('wallet_admin.action_reject', { defaultValue: 'Rechazar' }),
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
            title: t('wallet_admin.empty_ledger_title', { defaultValue: 'Sin movimientos' }),
            body: t('wallet_admin.empty_ledger_body', { defaultValue: 'Todavía no hay transacciones registradas en el libro mayor.' }),
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
