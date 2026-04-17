'use client';

/**
 * Dev-only preview to visually validate the data primitives.
 * Not linked from navigation — access with `?__preview=1` (dev only).
 * The middleware gates this query param by NODE_ENV so production builds
 * still require authentication.
 */

import { useMemo, useState } from 'react';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { StatusBadge } from '@/components/data/StatusBadge';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { DataEmptyState } from '@/components/data/DataEmptyState';
import { MapPin, Search } from 'lucide-react';

type Row = {
  id: string;
  pickup: string;
  dropoff: string;
  driver: string;
  fare: number;
  status:
    | 'searching'
    | 'accepted'
    | 'in_progress'
    | 'completed'
    | 'canceled'
    | 'disputed';
  created_at: string;
};

const PLACES = [
  'Vedado',
  'Habana Vieja',
  'Miramar',
  'Centro Habana',
  'Playa',
  'Diez de Octubre',
  'Guanabacoa',
  'Cerro',
];

function seed(n: number): Row[] {
  const statuses: Row['status'][] = [
    'searching',
    'accepted',
    'in_progress',
    'completed',
    'completed',
    'completed',
    'canceled',
    'disputed',
  ];
  return Array.from({ length: n }).map((_, i) => ({
    id: `r-${String(i).padStart(6, '0')}`,
    pickup: PLACES[i % PLACES.length] + ', #' + ((i * 7) % 99 + 1),
    dropoff: PLACES[(i * 3) % PLACES.length] + ', #' + ((i * 11) % 99 + 1),
    driver: ['L. Pérez', 'A. García', 'M. Castro', 'J. Díaz', 'R. Sánchez'][i % 5] || 'L. Pérez',
    fare: 80 + ((i * 37) % 420),
    status: statuses[i % statuses.length] || 'completed',
    created_at: new Date(Date.now() - i * 1000 * 60 * 7).toISOString(),
  }));
}

const ALL_ROWS = seed(58);

const TABS: StatusTab[] = [
  { id: 'all', label: 'Todos' },
  { id: 'searching', label: 'Buscando', tone: 'warning' },
  { id: 'in_progress', label: 'En curso', tone: 'primary' },
  { id: 'completed', label: 'Completados', tone: 'success' },
  { id: 'canceled', label: 'Cancelados', tone: 'danger' },
  { id: 'disputed', label: 'Disputas', tone: 'warning' },
];

function formatRelative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'hace un instante';
  if (mins < 60) return `hace ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

export default function DataPreviewPage() {
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ columnId: string; direction: 'asc' | 'desc' } | null>({
    columnId: 'created_at',
    direction: 'desc',
  });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [forceEmpty, setForceEmpty] = useState(false);
  const [forceLoading, setForceLoading] = useState(false);
  const [forceError, setForceError] = useState(false);

  const filteredRows = useMemo(() => {
    const tabs = TABS.map((t) => t.id);
    let rows = ALL_ROWS;
    if (tab !== 'all' && tabs.includes(tab)) {
      rows = rows.filter((r) => r.status === tab);
    }
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.pickup.toLowerCase().includes(q) ||
          r.dropoff.toLowerCase().includes(q) ||
          r.driver.toLowerCase().includes(q) ||
          r.id.includes(q),
      );
    }
    if (sort) {
      const dir = sort.direction === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const k = sort.columnId as keyof Row;
        if (k === 'fare') return ((a.fare - b.fare) as number) * dir;
        return String(a[k]).localeCompare(String(b[k])) * dir;
      });
    }
    return rows;
  }, [tab, search, sort]);

  const total = forceEmpty ? 0 : filteredRows.length;
  const paginated = forceEmpty ? [] : filteredRows.slice(page * pageSize, (page + 1) * pageSize);

  const columns: DataColumn<Row>[] = [
    {
      id: 'id',
      header: 'ID',
      cell: (r) => <span>{r.id}</span>,
      mono: true,
      hideBelow: 'lg',
      width: '120px',
    },
    {
      id: 'pickup',
      header: 'Origen → Destino',
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{r.pickup}</span>
          <span aria-hidden="true" className="text-ink-subtle">
            →
          </span>
          <span className="truncate text-ink-muted">{r.dropoff}</span>
        </span>
      ),
      sortKey: 'pickup',
      primary: true,
    },
    {
      id: 'driver',
      header: 'Conductor',
      cell: (r) => r.driver,
      sortKey: 'driver',
      secondary: true,
      hideBelow: 'md',
    },
    {
      id: 'fare',
      header: 'Tarifa',
      cell: (r) => <span>{r.fare.toLocaleString('es-CU')} CUP</span>,
      align: 'right',
      mono: true,
      sortKey: 'fare',
      hideBelow: 'md',
      width: '110px',
    },
    {
      id: 'status',
      header: 'Estado',
      cell: (r) => <StatusBadge domain="ride" status={r.status} />,
      width: '160px',
    },
    {
      id: 'created_at',
      header: 'Creado',
      cell: (r) => <span className="text-ink-muted">{formatRelative(r.created_at)}</span>,
      sortKey: 'created_at',
      hideBelow: 'lg',
      width: '120px',
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            Preview / Fase 3
          </p>
          <h1 className="font-display text-[24px] font-semibold tracking-tight text-ink">
            Primitivos de datos — Cuba
          </h1>
          <p className="mt-1 text-[12.5px] text-ink-muted">
            Demo de <code className="font-mono">DataTable</code>, <code className="font-mono">FilterBar</code>,
            <code className="font-mono"> StatusBadge</code> y <code className="font-mono">DataEmptyState</code>.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <label className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1">
            <input
              type="checkbox"
              checked={forceLoading}
              onChange={(e) => setForceLoading(e.target.checked)}
            />
            <span>Loading</span>
          </label>
          <label className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1">
            <input
              type="checkbox"
              checked={forceEmpty}
              onChange={(e) => setForceEmpty(e.target.checked)}
            />
            <span>Empty</span>
          </label>
          <label className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1">
            <input
              type="checkbox"
              checked={forceError}
              onChange={(e) => setForceError(e.target.checked)}
            />
            <span>Error</span>
          </label>
        </div>
      </div>

      <FilterBar
        sticky
        tabs={TABS}
        activeTab={tab}
        onTabChange={(t) => {
          setTab(t);
          setPage(0);
        }}
        search={{ value: search, onChange: (v) => { setSearch(v); setPage(0); }, placeholder: 'Buscar por origen, destino, conductor, ID…' }}
        activeFilterCount={0}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Provincia</span>
            <select className="rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] text-ink focus:border-primary-500 focus:outline-none">
              <option>Todo Cuba</option>
              <option>La Habana</option>
              <option>Matanzas</option>
              <option>Santiago de Cuba</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Desde</span>
            <input type="date" className="rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] text-ink focus:border-primary-500 focus:outline-none" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Hasta</span>
            <input type="date" className="rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] text-ink focus:border-primary-500 focus:outline-none" />
          </label>
        </div>
      </FilterBar>

      <DataTable<Row>
        columns={columns}
        rows={paginated}
        keyField="id"
        loading={forceLoading}
        error={forceError ? 'Error simulado del servidor (dummy).' : null}
        onRetry={() => setForceError(false)}
        empty={{
          icon: Search,
          title: 'Sin viajes que coincidan',
          body: 'Probá cambiar de pestaña o ajustar la búsqueda.',
        }}
        rowHref={(r) => `/rides/${r.id}`}
        sort={sort}
        onSortChange={setSort}
        pagination={{ page, pageSize, total }}
        onPaginationChange={(next) => {
          setPage(next.page);
          setPageSize(next.pageSize);
        }}
        rowActions={[
          { label: 'Ver', onClick: (r) => alert('Ver ' + r.id) },
          { label: 'Cancelar', tone: 'danger', onClick: (r) => alert('Cancelar ' + r.id) },
        ]}
      />

      <section className="admin-card p-5">
        <h2 className="mb-3 font-display text-[15px] font-semibold text-ink">StatusBadge · dominios</h2>
        <div className="flex flex-wrap gap-2">
          <StatusBadge domain="ride" status="searching" />
          <StatusBadge domain="ride" status="in_progress" />
          <StatusBadge domain="ride" status="completed" />
          <StatusBadge domain="ride" status="canceled" />
          <StatusBadge domain="driver" status="verified" />
          <StatusBadge domain="driver" status="pending_verification" />
          <StatusBadge domain="incident" status="open" />
          <StatusBadge domain="incident" status="resolved" />
          <StatusBadge domain="payment" status="pending" />
          <StatusBadge domain="payment" status="failed" />
          <StatusBadge domain="payment" status="refunded" />
        </div>
      </section>

      <section className="admin-card p-5">
        <h2 className="mb-3 font-display text-[15px] font-semibold text-ink">DataEmptyState</h2>
        <DataEmptyState
          icon={MapPin}
          tone="primary"
          title="Todavía no hay nada por acá"
          body="Cuando haya actividad, la vas a ver en esta sección en tiempo real."
          action={{ label: 'Ir al mapa', href: '/live-map' }}
        />
      </section>
    </div>
  );
}
