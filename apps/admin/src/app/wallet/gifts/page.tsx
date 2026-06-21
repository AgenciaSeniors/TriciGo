'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gift, Plus } from 'lucide-react';
import { adminService } from '@tricigo/api';
import { formatCUP, getErrorMessage } from '@tricigo/utils';
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
  const [stats, setStats] = useState({ total_gifts: 0, reversed: 0, volume_cup: 0, gifts_7d: 0, distinct_senders: 0 });
  const [freezeModal, setFreezeModal] = useState<{ open: boolean; userId: string; reason: string }>({ open: false, userId: '', reason: '' });
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
      const [rows, s] = await Promise.all([
        adminService.listGifts(PAGE_SIZE, page * PAGE_SIZE),
        adminService.getGiftStats().catch(() => null),
      ]);
      setGifts(rows);
      if (s) setStats(s);
    } catch (err) {
      setGifts([]);
      setError(getErrorMessage(err));
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
          showToast('error', getErrorMessage(err));
        }
      },
    });
  };

  const handleFreeze = (g: WalletTransfer) => {
    if (!g.from_user_id) return;
    setFreezeModal({ open: true, userId: g.from_user_id, reason: '' });
  };

  const handleConfirmFreeze = async () => {
    if (freezeModal.reason.trim().length < 3) return;
    try {
      await adminService.freezeWallet(freezeModal.userId, freezeModal.reason.trim());
      showToast('success', t('gifts.freeze_success', { defaultValue: 'Billetera congelada' }));
      setFreezeModal({ open: false, userId: '', reason: '' });
      await fetchData();
    } catch (err) {
      showToast('error', getErrorMessage(err));
    }
  };

  const handleUnfreeze = (g: WalletTransfer) => {
    if (!g.from_user_id) return;
    const uid = g.from_user_id;
    setConfirmModal({
      open: true,
      title: t('gifts.unfreeze_title', { defaultValue: 'Descongelar billetera' }),
      message: t('gifts.unfreeze_confirm', { defaultValue: 'El emisor podrá volver a enviar regalos y gastar su saldo.' }),
      action: async () => {
        setConfirmModal((prev) => ({ ...prev, open: false }));
        try {
          await adminService.unfreezeWallet(uid);
          showToast('success', t('gifts.unfreeze_success', { defaultValue: 'Billetera descongelada' }));
        } catch (err) {
          showToast('error', getErrorMessage(err));
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
      showToast('error', getErrorMessage(err));
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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t('gifts.kpi_total', { defaultValue: 'Total regalos' })} value={String(stats.total_gifts)} loading={loading} />
        <KpiCard
          label={t('gifts.kpi_reversed', { defaultValue: 'Revertidos' })}
          value={String(stats.reversed)}
          tone={stats.reversed > 0 ? 'danger' : 'default'}
          loading={loading}
        />
        <KpiCard
          label={t('gifts.kpi_volume', { defaultValue: 'Volumen activo' })}
          value={formatCUP(stats.volume_cup).replace('CUP', '').trim()}
          unit="CUP"
          tone="primary"
          loading={loading}
        />
        <KpiCard label={t('gifts.kpi_7d', { defaultValue: 'Últimos 7 días' })} value={String(stats.gifts_7d)} loading={loading} />
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
          {
            label: t('gifts.action_freeze', { defaultValue: 'Congelar emisor' }),
            tone: 'danger',
            onClick: (g) => { if (g.from_user_id) handleFreeze(g); },
          },
          {
            label: t('gifts.action_unfreeze', { defaultValue: 'Descongelar emisor' }),
            onClick: (g) => { if (g.from_user_id) handleUnfreeze(g); },
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

      {freezeModal.open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setFreezeModal((p) => ({ ...p, open: false }))}
        >
          <div className="admin-card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="font-display text-[18px] font-semibold text-ink">
              {t('gifts.freeze_title', { defaultValue: 'Congelar billetera' })}
            </h3>
            <p className="mt-0.5 text-[12.5px] text-ink-muted">
              {t('gifts.freeze_help', { defaultValue: 'El emisor no podrá enviar regalos ni gastar su saldo hasta descongelar.' })}
            </p>
            <label className="mt-4 flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
                {t('gifts.freeze_reason', { defaultValue: 'Motivo (obligatorio)' })}
              </span>
              <textarea
                value={freezeModal.reason}
                onChange={(e) => setFreezeModal((p) => ({ ...p, reason: e.target.value }))}
                rows={3}
                className="rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink focus:border-primary-500 focus:outline-none resize-none"
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setFreezeModal((p) => ({ ...p, open: false }))}
                className="rounded-lg border border-line bg-surface px-4 py-2 text-[13px] font-medium text-ink hover:bg-surface-sunken"
              >
                {t('gifts.cancel', { defaultValue: 'Cancelar' })}
              </button>
              <button
                type="button"
                disabled={freezeModal.reason.trim().length < 3}
                onClick={handleConfirmFreeze}
                className="rounded-lg bg-red-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {t('gifts.freeze_confirm', { defaultValue: 'Congelar' })}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
