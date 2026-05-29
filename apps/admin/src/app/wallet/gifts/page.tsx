'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gift, Plus } from 'lucide-react';
import { adminService } from '@tricigo/api';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { WalletTransfer } from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { SendGiftModal } from '@/components/ui/SendGiftModal';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { formatAdminDate } from '@/lib/formatDate';

const PAGE_SIZE = 20;

type Filter = 'all' | 'gift' | 'reversed';

export default function GiftsPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const TABS: StatusTab<Filter>[] = useMemo(() => [
    { id: 'all', label: t('gifts.filter_all', { defaultValue: 'Todos' }) },
    { id: 'gift', label: t('gifts.filter_gifts', { defaultValue: 'Regalos' }), tone: 'success' },
    { id: 'reversed', label: t('gifts.filter_reversed', { defaultValue: 'Revertidos' }), tone: 'danger' },
  ], [t]);

  const [gifts, setGifts] = useState<WalletTransfer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortState | null>({ columnId: 'created_at', direction: 'desc' });
  const [sendOpen, setSendOpen] = useState(false);
  const [sending, setSending] = useState(false);
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
      const rows = await adminService.listGifts(PAGE_SIZE, page * PAGE_SIZE);
      setGifts(rows);
    } catch (err) {
      setGifts([]);
      setError(err instanceof Error ? err.message : t('gifts.load_error', { defaultValue: 'No pudimos cargar los regalos.' }));
    } finally {
      setLoading(false);
    }
  }, [page, t]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const filtered = useMemo(() => {
    let rows = gifts;
    if (filter === 'gift') rows = rows.filter((g) => g.kind === 'gift' && !g.reversed_at);
    else if (filter === 'reversed') rows = rows.filter((g) => !!g.reversed_at || g.kind === 'gift_reversal');
    if (!sort) return rows;
    const dir = sort.direction === 'asc' ? 1 : -1;
    const key = sort.columnId as keyof WalletTransfer;
    return [...rows].sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * dir);
  }, [gifts, filter, sort]);

  const stats = useMemo(() => {
    const giftRows = gifts.filter((g) => g.kind === 'gift');
    return {
      total: gifts.length,
      reversed: gifts.filter((g) => !!g.reversed_at).length,
      volume: giftRows.reduce((sum, g) => sum + (g.reversed_at ? 0 : g.amount), 0),
    };
  }, [gifts]);

  const handleReverse = (g: WalletTransfer) => {
    setConfirmModal({
      open: true,
      title: t('gifts.reverse_title', { defaultValue: 'Revertir regalo' }),
      message: t('gifts.reverse_confirm', {
        defaultValue: 'Esto crea un asiento de compensación que devuelve el saldo al emisor. No se puede deshacer.',
      }),
      variant: 'danger',
      action: async () => {
        setConfirmModal((prev) => ({ ...prev, open: false }));
        try {
          await adminService.reverseGift(g.id);
          showToast('success', t('gifts.reverse_success', { defaultValue: 'Regalo revertido' }));
          await fetchData();
        } catch (err) {
          showToast('error', err instanceof Error ? err.message : t('gifts.reverse_error', { defaultValue: 'No pudimos revertir el regalo.' }));
        }
      },
    });
  };

  const handleSendGift = async (args: { toUserId: string; amount: number; note: string }) => {
    setSending(true);
    try {
      await adminService.sendGift(args.toUserId, args.amount, args.note);
      showToast('success', t('gifts.send_success', { defaultValue: 'Regalo enviado' }));
      setSendOpen(false);
      await fetchData();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : t('gifts.send_error', { defaultValue: 'No pudimos enviar el regalo.' }));
    } finally {
      setSending(false);
    }
  };

  const kindLabel = (kind: string): string => {
    if (kind === 'gift_reversal') return t('gifts.kind_reversal', { defaultValue: 'Reversión' });
    if (kind === 'transfer') return t('gifts.kind_transfer', { defaultValue: 'Transferencia' });
    return t('gifts.kind_gift', { defaultValue: 'Regalo' });
  };

  const columns: DataColumn<WalletTransfer>[] = useMemo(
    () => [
      {
        id: 'from_user_id',
        header: t('gifts.col_from', { defaultValue: 'De' }),
        cell: (g) => (g.from_user_id ? `${g.from_user_id.substring(0, 8)}…` : t('gifts.from_platform', { defaultValue: 'Plataforma' })),
        primary: true,
        mono: true,
        width: '150px',
      },
      {
        id: 'to_user_id',
        header: t('gifts.col_to', { defaultValue: 'Para' }),
        cell: (g) => `${g.to_user_id.substring(0, 8)}…`,
        mono: true,
        width: '150px',
      },
      {
        id: 'amount',
        header: t('gifts.col_amount', { defaultValue: 'Monto' }),
        cell: (g) => <span className="font-medium text-ink">{formatCUP(g.amount)}</span>,
        align: 'right',
        mono: true,
        width: '140px',
        secondary: true,
      },
      {
        id: 'kind',
        header: t('gifts.col_kind', { defaultValue: 'Tipo' }),
        cell: (g) => <span className="text-ink-muted">{kindLabel(g.kind)}</span>,
        width: '130px',
        hideBelow: 'md',
      },
      {
        id: 'status',
        header: t('gifts.col_status', { defaultValue: 'Estado' }),
        cell: (g) =>
          g.reversed_at ? (
            <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
              {t('gifts.status_reversed', { defaultValue: 'Revertido' })}
            </span>
          ) : (
            <span className="text-ink-subtle">—</span>
          ),
        width: '120px',
      },
      {
        id: 'created_at',
        header: t('gifts.col_date', { defaultValue: 'Fecha' }),
        cell: (g) => <span className="text-ink-muted">{formatAdminDate(g.created_at)}</span>,
        sortKey: 'created_at',
        hideBelow: 'lg',
        width: '170px',
      },
    ],
    [t],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('gifts.page_eyebrow', { defaultValue: 'Billeteras · regalos' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('gifts.title', { defaultValue: 'Regalos' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('gifts.page_description', { defaultValue: 'Transferencias de saldo entre usuarios (closed-loop). Podés enviar un regalo manual o revertir uno fraudulento.' })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSendOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary-600 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-primary-700"
        >
          <Plus className="h-4 w-4" />
          {t('gifts.send_button', { defaultValue: 'Enviar regalo' })}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <KpiCard label={t('gifts.kpi_total', { defaultValue: 'En esta página' })} value={String(stats.total)} loading={loading} />
        <KpiCard
          label={t('gifts.kpi_reversed', { defaultValue: 'Revertidos' })}
          value={String(stats.reversed)}
          tone={stats.reversed > 0 ? 'danger' : 'default'}
          loading={loading}
        />
        <KpiCard
          label={t('gifts.kpi_volume', { defaultValue: 'Volumen (regalos)' })}
          value={formatCUP(stats.volume).replace('CUP', '').trim()}
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

      <DataTable<WalletTransfer>
        columns={columns}
        rows={filtered}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => void fetchData()}
        empty={{
          icon: Gift,
          title: t('gifts.empty_title', { defaultValue: 'Sin regalos' }),
          body: t('gifts.empty_body', { defaultValue: 'Todavía nadie envió un regalo. Cuando suceda, vas a verlo acá.' }),
        }}
        sort={sort}
        onSortChange={setSort}
        pagination={{ page, pageSize: PAGE_SIZE, hasMore: gifts.length === PAGE_SIZE }}
        onPaginationChange={(next) => setPage(next.page)}
        rowActions={[
          {
            label: t('gifts.action_reverse', { defaultValue: 'Revertir' }),
            tone: 'danger',
            onClick: (g) => {
              if (g.kind === 'gift' && !g.reversed_at && g.from_user_id) handleReverse(g);
            },
          },
        ]}
      />

      <SendGiftModal
        open={sendOpen}
        loading={sending}
        onConfirm={handleSendGift}
        onCancel={() => setSendOpen(false)}
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
