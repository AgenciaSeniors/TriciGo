'use client';

import { useCallback, useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { corporateService } from '@tricigo/api';
import { formatTriciCoin } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { CorporateAccount, CorporateAccountStatus } from '@tricigo/types';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { StatusBadge } from '@/components/data/StatusBadge';
import { formatAdminDate } from '@/lib/formatDate';

const PAGE_SIZE = 20;

type Filter = 'all' | CorporateAccountStatus;

const TABS: StatusTab<Filter>[] = [
  { id: 'all', label: 'Todas' },
  { id: 'pending', label: 'Pendientes', tone: 'warning' },
  { id: 'approved', label: 'Aprobadas', tone: 'success' },
  { id: 'suspended', label: 'Suspendidas', tone: 'danger' },
  { id: 'rejected', label: 'Rechazadas' },
];

export default function BusinessesPage() {
  const { t: _t } = useTranslation('admin');
  const [tab, setTab] = useState<Filter>('all');
  const [accounts, setAccounts] = useState<CorporateAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await corporateService.listAccounts(
        tab === 'all' ? undefined : tab,
        page,
        PAGE_SIZE,
      );
      setAccounts(data);
    } catch (err) {
      setAccounts([]);
      setError(err instanceof Error ? err.message : 'No pudimos cargar las empresas.');
    } finally {
      setLoading(false);
    }
  }, [tab, page]);

  useEffect(() => {
    void fetchAccounts();
  }, [fetchAccounts]);

  const columns: DataColumn<CorporateAccount>[] = [
    {
      id: 'name',
      header: 'Empresa',
      cell: (a) => <span className="font-medium text-ink">{a.name}</span>,
      primary: true,
    },
    {
      id: 'contact_phone',
      header: 'Contacto',
      cell: (a) => a.contact_phone ?? <span className="text-ink-subtle">—</span>,
      mono: true,
      hideBelow: 'md',
      width: '170px',
    },
    {
      id: 'status',
      header: 'Estado',
      cell: (a) => <StatusBadge domain="corporate" status={a.status} />,
      width: '160px',
    },
    {
      id: 'spent',
      header: 'Gastado · mes',
      cell: (a) => (
        <span className="font-medium text-ink">
          {formatTriciCoin(a.current_month_spent)}
          {a.monthly_budget_trc > 0 && (
            <span className="text-[11px] text-ink-subtle"> / {formatTriciCoin(a.monthly_budget_trc)}</span>
          )}
        </span>
      ),
      align: 'right',
      mono: true,
      hideBelow: 'md',
      width: '200px',
      secondary: true,
    },
    {
      id: 'created_at',
      header: 'Creada',
      cell: (a) => <span className="text-ink-muted">{formatAdminDate(a.created_at)}</span>,
      hideBelow: 'lg',
      width: '170px',
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
          Crecimiento · aliados
        </p>
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
          Empresas aliadas
        </h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          Cuentas corporativas de TriciGo: viajes con presupuesto mensual y flota compartida.
        </p>
      </div>

      <FilterBar<Filter>
        sticky
        tabs={TABS}
        activeTab={tab}
        onTabChange={(id) => {
          setTab(id);
          setPage(0);
        }}
      />

      <DataTable<CorporateAccount>
        columns={columns}
        rows={accounts}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => void fetchAccounts()}
        empty={{
          icon: Building2,
          title: 'Sin empresas aliadas',
          body: 'Cuando se sume una cuenta corporativa, va a aparecer acá.',
        }}
        rowHref={(a) => `/businesses/${a.id}`}
        pagination={{ page, pageSize: PAGE_SIZE, hasMore: accounts.length === PAGE_SIZE }}
        onPaginationChange={(next) => setPage(next.page)}
      />
    </div>
  );
}
