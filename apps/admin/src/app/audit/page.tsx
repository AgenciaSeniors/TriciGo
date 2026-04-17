'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, ShieldCheck } from 'lucide-react';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import type { AdminAction } from '@tricigo/types';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { FilterBar } from '@/components/data/FilterBar';
import { formatAdminDate } from '@/lib/formatDate';

const PAGE_SIZE = 20;

const ACTION_LABEL: Record<string, string> = {
  approve_driver: 'Aprobó conductor',
  reject_driver: 'Rechazó conductor',
  suspend_driver: 'Suspendió conductor',
  approve_redemption: 'Aprobó retiro',
  reject_redemption: 'Rechazó retiro',
  approve_recharge: 'Aprobó recarga',
  reject_recharge: 'Rechazó recarga',
  incident_investigating: 'Pasó incidente a investigación',
  incident_resolved: 'Resolvió incidente',
};

const TARGET_LABEL: Record<string, string> = {
  driver_profile: 'Conductor',
  wallet_redemption: 'Retiro',
  wallet_recharge_request: 'Recarga',
  incident_report: 'Incidente',
};

export default function AuditPage() {
  const { t: _t } = useTranslation('admin');
  const [actions, setActions] = useState<AdminAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sort, setSort] = useState<SortState | null>({ columnId: 'created_at', direction: 'desc' });

  const fetchActions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const filters: { dateFrom?: string; dateTo?: string } = {};
      if (dateFrom) filters.dateFrom = dateFrom;
      if (dateTo) filters.dateTo = dateTo;
      const data = await adminService.getAdminActions(page, PAGE_SIZE, filters);
      setActions(data);
    } catch (err) {
      setActions([]);
      setError(err instanceof Error ? err.message : 'No pudimos cargar la auditoría.');
    } finally {
      setLoading(false);
    }
  }, [page, dateFrom, dateTo]);

  useEffect(() => {
    void fetchActions();
  }, [fetchActions]);

  const activeFilterCount = (dateFrom ? 1 : 0) + (dateTo ? 1 : 0);

  const columns: DataColumn<AdminAction>[] = useMemo(
    () => [
      {
        id: 'action',
        header: 'Acción',
        cell: (a) => (
          <span className="inline-flex items-center rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
            {ACTION_LABEL[a.action] ?? a.action.replace(/_/g, ' ')}
          </span>
        ),
        primary: true,
      },
      {
        id: 'target',
        header: 'Sobre',
        cell: (a) => (
          <span className="flex flex-col">
            <span className="text-ink">{TARGET_LABEL[a.target_type] ?? a.target_type}</span>
            {a.target_id && (
              <span className="font-mono text-[10px] text-ink-subtle">{a.target_id.slice(0, 10)}…</span>
            )}
          </span>
        ),
        secondary: true,
        width: '180px',
      },
      {
        id: 'admin_id',
        header: 'Admin',
        cell: (a) => `${a.admin_id.slice(0, 8)}…`,
        mono: true,
        hideBelow: 'md',
        width: '120px',
      },
      {
        id: 'reason',
        header: 'Motivo',
        cell: (a) =>
          a.reason ? (
            <span className="block max-w-xs truncate text-ink-muted" title={a.reason}>
              {a.reason}
            </span>
          ) : (
            <span className="text-ink-subtle">—</span>
          ),
        hideBelow: 'lg',
      },
      {
        id: 'created_at',
        header: 'Fecha',
        cell: (a) => <span className="text-ink-muted">{formatAdminDate(a.created_at)}</span>,
        sortKey: 'created_at',
        hideBelow: 'md',
        width: '170px',
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          Sistema · auditoría
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
          Auditoría
        </h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          Historial completo de acciones hechas por el equipo de administración.
        </p>
      </div>

      <FilterBar
        sticky
        activeFilterCount={activeFilterCount}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Desde</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(0);
              }}
              className="h-9 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Hasta</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => {
                if (dateFrom && e.target.value < dateFrom) return;
                setDateTo(e.target.value);
                setPage(0);
              }}
              className="h-9 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
            />
          </label>
        </div>
        {activeFilterCount > 0 && (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => {
                setDateFrom('');
                setDateTo('');
                setPage(0);
              }}
              className="text-[11.5px] font-medium text-ink-muted hover:text-ink"
            >
              Limpiar fechas
            </button>
          </div>
        )}
      </FilterBar>

      <DataTable<AdminAction>
        columns={columns}
        rows={actions}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => void fetchActions()}
        empty={{
          icon: activeFilterCount > 0 ? ClipboardList : ShieldCheck,
          title:
            activeFilterCount > 0 ? 'Sin acciones en ese rango' : 'Nada que auditar aún',
          body:
            activeFilterCount > 0
              ? 'Probá con otras fechas o limpiá el filtro.'
              : 'Cuando el equipo haga cambios, los vas a ver acá.',
        }}
        sort={sort}
        onSortChange={setSort}
        pagination={{ page, pageSize: PAGE_SIZE, hasMore: actions.length === PAGE_SIZE }}
        onPaginationChange={(next) => setPage(next.page)}
      />
    </div>
  );
}
