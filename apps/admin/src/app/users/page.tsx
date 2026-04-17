'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Users, UserX } from 'lucide-react';
import { adminService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { User, UserRole } from '@tricigo/types';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { formatAdminDate } from '@/lib/formatDate';
import { exportToCsv } from '@/lib/exportCsv';

const PAGE_SIZE = 20;

type RoleFilter = UserRole | 'all';

const ROLE_TABS: StatusTab<RoleFilter>[] = [
  { id: 'all', label: 'Todos' },
  { id: 'customer', label: 'Pasajeros', tone: 'info' },
  { id: 'driver', label: 'Conductores', tone: 'warning' },
  { id: 'admin', label: 'Administradores', tone: 'primary' },
];

const ROLE_CLASS: Record<string, string> = {
  customer: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  driver: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  admin: 'bg-primary-500/10 text-primary-600 dark:text-primary-400',
  super_admin: 'bg-red-500/10 text-red-600 dark:text-red-400',
};

const ROLE_LABEL: Record<string, string> = {
  customer: 'Pasajero',
  driver: 'Conductor',
  admin: 'Admin',
  super_admin: 'Super admin',
};

const EMPTY_FILTERS = {
  search: '',
  dateFrom: '',
  dateTo: '',
  isActive: '',
};

type AdvancedFilters = typeof EMPTY_FILTERS;

export default function UsersPage() {
  const { t } = useTranslation('admin');
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [filters, setFilters] = useState<AdvancedFilters>({ ...EMPTY_FILTERS });
  const [sort, setSort] = useState<SortState | null>({ columnId: 'created_at', direction: 'desc' });

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query: Record<string, unknown> = {};
      if (roleFilter !== 'all') query.role = roleFilter;
      if (filters.search) query.search = filters.search;
      if (filters.dateFrom) query.dateFrom = filters.dateFrom;
      if (filters.dateTo) query.dateTo = filters.dateTo;
      if (filters.isActive) query.isActive = filters.isActive === 'true';
      const data = await adminService.getUsers(page, PAGE_SIZE, query);
      setUsers(data);
    } catch (err) {
      setUsers([]);
      setError(err instanceof Error ? err.message : 'No pudimos cargar los pasajeros.');
    } finally {
      setLoading(false);
    }
  }, [page, roleFilter, filters]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const sortedUsers = useMemo(() => {
    if (!sort) return users;
    const dir = sort.direction === 'asc' ? 1 : -1;
    const key = sort.columnId as keyof User;
    return [...users].sort((a, b) => {
      const av = a[key] as unknown;
      const bv = b[key] as unknown;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [users, sort]);

  const activeFilterCount = useMemo(
    () =>
      (Object.keys(filters) as (keyof AdvancedFilters)[]).reduce(
        (acc, k) => acc + (filters[k] ? 1 : 0),
        0,
      ),
    [filters],
  );

  const updateFilter = useCallback(<K extends keyof AdvancedFilters>(key: K, value: AdvancedFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(0);
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({ ...EMPTY_FILTERS });
    setPage(0);
  }, []);

  const handleExportCsv = useCallback(() => {
    exportToCsv(
      sortedUsers as unknown as Record<string, unknown>[],
      [
        { key: 'full_name', label: 'Nombre' },
        { key: 'phone', label: 'Teléfono' },
        { key: 'email', label: 'Email' },
        { key: 'role', label: 'Rol' },
        { key: 'is_active', label: 'Activo', format: (v) => (v ? 'Sí' : 'No') },
        { key: 'created_at', label: 'Registrado' },
      ],
      'users',
    );
  }, [sortedUsers]);

  const columns: DataColumn<User>[] = useMemo(
    () => [
      {
        id: 'full_name',
        header: 'Nombre',
        cell: (u) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-ink">{u.full_name || '—'}</span>
            {u.email && (
              <span className="truncate text-[11.5px] text-ink-muted">{u.email}</span>
            )}
          </span>
        ),
        sortKey: 'full_name',
        primary: true,
      },
      {
        id: 'phone',
        header: 'Teléfono',
        cell: (u) => u.phone || '—',
        mono: true,
        hideBelow: 'md',
        width: '160px',
      },
      {
        id: 'role',
        header: 'Rol',
        cell: (u) => (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
              ROLE_CLASS[u.role] ?? 'bg-surface-sunken text-ink-muted'
            }`}
          >
            {ROLE_LABEL[u.role] ?? u.role}
          </span>
        ),
        width: '130px',
      },
      {
        id: 'is_active',
        header: 'Estado',
        cell: (u) =>
          u.is_active ? (
            <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              Activo
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-muted">
              Inactivo
            </span>
          ),
        width: '110px',
      },
      {
        id: 'created_at',
        header: 'Registrado',
        cell: (u) => <span className="text-ink-muted">{formatAdminDate(u.created_at)}</span>,
        sortKey: 'created_at',
        hideBelow: 'lg',
        width: '170px',
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            Gente · pasajeros
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            Usuarios
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            Todas las personas registradas en TriciGo — pasajeros, conductores y equipo.
          </p>
        </div>
        <button
          type="button"
          onClick={handleExportCsv}
          disabled={sortedUsers.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          Exportar CSV
        </button>
      </div>

      <FilterBar<RoleFilter>
        sticky
        tabs={ROLE_TABS}
        activeTab={roleFilter}
        onTabChange={(id) => {
          setRoleFilter(id);
          setPage(0);
        }}
        search={{
          value: filters.search,
          onChange: (v) => updateFilter('search', v),
          placeholder: 'Buscar por nombre, teléfono o email…',
        }}
        activeFilterCount={activeFilterCount - (filters.search ? 1 : 0)}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
              Estado
            </span>
            <select
              value={filters.isActive}
              onChange={(e) => updateFilter('isActive', e.target.value)}
              className="h-9 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
            >
              <option value="">Todos</option>
              <option value="true">Activos</option>
              <option value="false">Inactivos</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
              Desde
            </span>
            <input
              type="date"
              value={filters.dateFrom}
              onChange={(e) => updateFilter('dateFrom', e.target.value)}
              className="h-9 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
              Hasta
            </span>
            <input
              type="date"
              value={filters.dateTo}
              onChange={(e) => updateFilter('dateTo', e.target.value)}
              className="h-9 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
            />
          </label>
        </div>
        {activeFilterCount > 0 && (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={clearFilters}
              className="text-[11.5px] font-medium text-ink-muted hover:text-ink"
            >
              Limpiar todo
            </button>
          </div>
        )}
      </FilterBar>

      <DataTable<User>
        columns={columns}
        rows={sortedUsers}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => {
          setError(null);
          void fetchUsers();
        }}
        empty={
          activeFilterCount > 0 || roleFilter !== 'all'
            ? {
                icon: UserX,
                title: 'Sin usuarios que coincidan',
                body: 'Probá limpiar los filtros o cambiar la pestaña.',
                action: { label: 'Limpiar filtros', onClick: clearFilters },
              }
            : {
                icon: Users,
                title: 'Sin usuarios aún',
                body: 'Cuando alguien se registre, va a aparecer acá.',
              }
        }
        rowHref={(u) => `/users/${u.id}`}
        sort={sort}
        onSortChange={setSort}
        pagination={{
          page,
          pageSize: PAGE_SIZE,
          hasMore: users.length === PAGE_SIZE,
        }}
        onPaginationChange={(next) => setPage(next.page)}
      />
    </div>
  );
}
