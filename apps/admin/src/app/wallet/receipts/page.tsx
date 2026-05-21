'use client';

// ============================================================
// Admin · Wallet recharge receipts (Wallet v2 PR 9/9)
// ============================================================
// Read-only tab listing every wallet_receipts row (RLS grants admins
// full SELECT via the wallet_receipts_admin_all policy from PR 1).
// Each row links to the user, shows the USD/CUP breakdown + card
// brand, and offers a "Descargar PDF" button when the EF has already
// generated the file. Rows whose pdf_storage_path is NULL surface as
// "Pendiente" so admins know the EF hasn't processed them yet.
// ============================================================

import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { Download, RefreshCcw, Search, FileText } from 'lucide-react';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import { useToast } from '@/components/ui/AdminToast';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { AdminEmptyState } from '@/components/ui/AdminEmptyState';
import { formatAdminDate } from '@/lib/formatDate';

type ReceiptRow = Awaited<ReturnType<typeof adminService.getRecentReceipts>>[number];

const PAGE_SIZE = 50;

function formatUsd(value: string | number) {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return '$' + (Number.isFinite(n) ? n.toFixed(2) : '0.00');
}

function formatCup(value: string | number) {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return new Intl.NumberFormat('es-CU', { maximumFractionDigits: 0 }).format(Number.isFinite(n) ? n : 0) + ' CUP';
}

function formatTc(value: string | number) {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return (Number.isFinite(n) ? n.toFixed(2) : '0.00') + ' TC';
}

function capitalize(s: string | null) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function AdminReceiptsPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminService.getRecentReceipts(page, PAGE_SIZE, search);
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar comprobantes');
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => { void load(); }, [load]);

  const handleDownload = async (row: ReceiptRow) => {
    if (!row.pdf_storage_path) return;
    setDownloading(row.id);
    try {
      const url = await adminService.getReceiptSignedUrl(row.pdf_storage_path);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      showToast('error', t('receipts.download_failed', { defaultValue: 'No pudimos abrir el PDF' }));
    } finally {
      setDownloading(null);
    }
  };

  const totals = useMemo(() => {
    const sumUsd = rows.reduce((s, r) => s + parseFloat(r.usd_charged || '0'), 0);
    const sumTc = rows.reduce((s, r) => s + parseFloat(r.tc_credited || '0'), 0);
    const withPdf = rows.filter((r) => !!r.pdf_storage_path).length;
    const sentToUser = rows.filter((r) => !!r.email_sent_at_user).length;
    return { count: rows.length, sumUsd, sumTc, withPdf, sentToUser };
  }, [rows]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('receipts.eyebrow', { defaultValue: 'Wallet · cumplimiento' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('receipts.title', { defaultValue: 'Comprobantes emitidos' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('receipts.description', {
              defaultValue: 'Recibos PDF generados para cada recarga con tarjeta. Auditoría 7 años.',
            })}
          </p>
        </div>
        <button
          onClick={() => { setPage(0); void load(); }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-sunken"
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          {t('common.refresh', { defaultValue: 'Refrescar' })}
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">{t('receipts.kpi_count', { defaultValue: 'Comprobantes' })}</p>
          <p className="mt-1 font-editorial text-[26px] leading-none italic text-primary-500">{totals.count}</p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">{t('receipts.kpi_total_usd', { defaultValue: 'USD cobrado' })}</p>
          <p className="mt-1 font-editorial text-[26px] leading-none italic text-ink">{formatUsd(totals.sumUsd)}</p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">{t('receipts.kpi_total_tc', { defaultValue: 'TC acreditados' })}</p>
          <p className="mt-1 font-editorial text-[26px] leading-none italic text-ink">{totals.sumTc.toFixed(0)} TC</p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">{t('receipts.kpi_with_pdf', { defaultValue: 'Con PDF' })}</p>
          <p className="mt-1 font-editorial text-[26px] leading-none italic text-emerald-600">{totals.withPdf}/{totals.count}</p>
        </div>
      </div>

      {/* Search + filters */}
      <form
        onSubmit={(e) => { e.preventDefault(); setSearch(searchInput); setPage(0); }}
        className="flex flex-wrap items-center gap-2"
      >
        <div className="relative flex-1 min-w-[240px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('receipts.search_placeholder', { defaultValue: 'Buscar por nº TG- o ID de transacción' })}
            className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          className="h-9 rounded-lg border border-line bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-surface-sunken"
        >
          {t('common.search', { defaultValue: 'Buscar' })}
        </button>
        {search && (
          <button
            type="button"
            onClick={() => { setSearchInput(''); setSearch(''); setPage(0); }}
            className="h-9 rounded-lg border border-line bg-surface px-3 text-[12.5px] text-ink-muted hover:bg-surface-sunken"
          >
            {t('common.clear', { defaultValue: 'Limpiar' })}
          </button>
        )}
      </form>

      {error && (
        <AdminErrorBanner message={error} onRetry={() => void load()} onDismiss={() => setError(null)} />
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-surface-sunken">
            <tr>
              <th className="text-left px-3 py-2 font-medium text-ink-muted text-[12px]">{t('receipts.col_no', { defaultValue: 'Nº' })}</th>
              <th className="text-left px-3 py-2 font-medium text-ink-muted text-[12px]">{t('receipts.col_user', { defaultValue: 'Usuario' })}</th>
              <th className="text-right px-3 py-2 font-medium text-ink-muted text-[12px]">{t('receipts.col_charged', { defaultValue: 'Cobrado' })}</th>
              <th className="text-right px-3 py-2 font-medium text-ink-muted text-[12px]">{t('receipts.col_fee', { defaultValue: 'Fee' })}</th>
              <th className="text-right px-3 py-2 font-medium text-ink-muted text-[12px]">{t('receipts.col_tc', { defaultValue: 'TC' })}</th>
              <th className="text-right px-3 py-2 font-medium text-ink-muted text-[12px]">{t('receipts.col_cup_eq', { defaultValue: 'CUP eq.' })}</th>
              <th className="text-left px-3 py-2 font-medium text-ink-muted text-[12px]">{t('receipts.col_card', { defaultValue: 'Tarjeta' })}</th>
              <th className="text-left px-3 py-2 font-medium text-ink-muted text-[12px]">{t('receipts.col_date', { defaultValue: 'Fecha' })}</th>
              <th className="text-left px-3 py-2 font-medium text-ink-muted text-[12px]">{t('receipts.col_status', { defaultValue: 'PDF' })}</th>
              <th className="text-right px-3 py-2 font-medium text-ink-muted text-[12px]">{t('common.actions', { defaultValue: 'Acciones' })}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10}><AdminTableSkeleton rows={6} columns={10} /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={10}>
                <AdminEmptyState
                  icon={<FileText className="w-10 h-10 text-neutral-300 dark:text-neutral-500" />}
                  title={t('receipts.empty_title', { defaultValue: 'Sin comprobantes' })}
                  description={search
                    ? t('receipts.empty_search', { defaultValue: 'Ninguno coincide con la búsqueda.' })
                    : t('receipts.empty_body', { defaultValue: 'Las recargas con tarjeta completadas aparecerán aquí.' })}
                />
              </td></tr>
            ) : (
              rows.map((r) => {
                const isPending = !r.pdf_storage_path;
                return (
                  <tr key={r.id} className="border-b border-line/60 hover:bg-surface-sunken">
                    <td className="px-3 py-2 font-mono text-[12px] font-semibold text-ink">{r.receipt_no}</td>
                    <td className="px-3 py-2 text-ink">
                      <Link href={`/users/${r.user_id}`} className="hover:underline">
                        {r.user?.full_name ?? '—'}
                      </Link>
                      {r.user?.email && (
                        <p className="text-[11px] text-ink-muted">{r.user.email}</p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-ink font-mono text-[12px]">{formatUsd(r.usd_charged)}</td>
                    <td className="px-3 py-2 text-right text-ink-muted font-mono text-[12px]">-{formatUsd(r.fee_usd)}</td>
                    <td className="px-3 py-2 text-right text-primary-600 font-mono text-[12px] font-semibold">{formatTc(r.tc_credited)}</td>
                    <td className="px-3 py-2 text-right text-ink-muted font-mono text-[12px]">{formatCup(r.cup_equivalent)}</td>
                    <td className="px-3 py-2 text-ink text-[12px]">
                      {r.card_brand && r.card_last4
                        ? <>{capitalize(r.card_brand)} <span className="font-mono text-ink-muted">•••• {r.card_last4}</span></>
                        : <span className="text-ink-subtle">—</span>}
                    </td>
                    <td className="px-3 py-2 text-ink-muted text-[12px]">{formatAdminDate(r.created_at)}</td>
                    <td className="px-3 py-2">
                      {isPending ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-800">{t('receipts.status_pending', { defaultValue: 'Pendiente' })}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-800">{t('receipts.status_ready', { defaultValue: 'Listo' })}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => handleDownload(r)}
                        disabled={isPending || downloading === r.id}
                        className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-[11.5px] font-medium text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label={`Descargar ${r.receipt_no}`}
                      >
                        <Download className="h-3 w-3" />
                        {downloading === r.id ? t('receipts.opening', { defaultValue: 'Abriendo…' }) : t('receipts.download', { defaultValue: 'PDF' })}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {!loading && rows.length === PAGE_SIZE && (
        <div className="flex justify-center gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink hover:bg-surface-sunken disabled:opacity-40"
          >
            {t('common.previous', { defaultValue: 'Anterior' })}
          </button>
          <span className="self-center text-[12.5px] text-ink-muted">{t('common.page', { defaultValue: 'Página' })} {page + 1}</span>
          <button
            type="button"
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink hover:bg-surface-sunken"
          >
            {t('common.next', { defaultValue: 'Siguiente' })}
          </button>
        </div>
      )}
    </div>
  );
}
