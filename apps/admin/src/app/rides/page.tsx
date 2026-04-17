'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Route, Search } from 'lucide-react';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { Ride } from '@tricigo/types';
import { createBrowserClient } from '@/lib/supabase-server';
import { FilterBar, type StatusTab } from '@/components/data/FilterBar';
import { DataTable, type DataColumn, type SortState } from '@/components/data/DataTable';
import { StatusBadge } from '@/components/data/StatusBadge';
import { formatAdminDate } from '@/lib/formatDate';
import { exportToCsv } from '@/lib/exportCsv';

const PAGE_SIZE = 20;

type StatusFilter = 'all' | 'searching' | 'accepted' | 'in_progress' | 'completed' | 'canceled' | 'disputed';

const EMPTY_FILTERS = {
  serviceType: '',
  paymentMethod: '',
  dateFrom: '',
  dateTo: '',
  search: '',
};

type AdvancedFilters = typeof EMPTY_FILTERS;

function truncate(str: string | null | undefined, len: number) {
  if (!str) return '—';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

export default function RidesPage() {
  const { t } = useTranslation('admin');

  const STATUS_TABS: StatusTab<StatusFilter>[] = useMemo(() => [
    { id: 'all', label: t('rides.filter_all', { defaultValue: 'Todos' }) },
    { id: 'searching', label: t('rides.filter_searching', { defaultValue: 'Buscando' }), tone: 'warning' },
    { id: 'accepted', label: t('rides.filter_accepted', { defaultValue: 'Aceptados' }), tone: 'info' },
    { id: 'in_progress', label: t('rides.filter_in_progress', { defaultValue: 'En curso' }), tone: 'primary' },
    { id: 'completed', label: t('rides.filter_completed', { defaultValue: 'Completados' }), tone: 'success' },
    { id: 'canceled', label: t('rides.filter_canceled', { defaultValue: 'Cancelados' }), tone: 'danger' },
    { id: 'disputed', label: t('rides.filter_disputed', { defaultValue: 'En disputa' }), tone: 'warning' },
  ], [t]);

  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [filters, setFilters] = useState<AdvancedFilters>({ ...EMPTY_FILTERS });
  const [cities, setCities] = useState<{ id: string; name: string }[]>([]);
  const [selectedCity, setSelectedCity] = useState('');
  const [sort, setSort] = useState<SortState | null>({ columnId: 'created_at', direction: 'desc' });

  useEffect(() => {
    const supabase = createBrowserClient();
    supabase
      .from('cities')
      .select('id, name')
      .eq('is_active', true)
      .order('name')
      .then(({ data }) => {
        if (data) setCities(data);
      });
  }, []);

  const fetchRides = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query: Record<string, string> = {};
      if (statusFilter !== 'all') query.status = statusFilter;
      if (filters.serviceType) query.serviceType = filters.serviceType;
      if (filters.paymentMethod) query.paymentMethod = filters.paymentMethod;
      if (filters.dateFrom) query.dateFrom = filters.dateFrom;
      if (filters.dateTo) query.dateTo = filters.dateTo;
      if (filters.search) query.search = filters.search;
      if (selectedCity) query.cityId = selectedCity;
      const data = await adminService.getRides(query, page, PAGE_SIZE);
      setRides(data);
    } catch (err) {
      setRides([]);
      setError(err instanceof Error ? err.message : t('rides.load_error', { defaultValue: 'No pudimos cargar los viajes.' }));
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, filters, selectedCity]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchRides();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchRides]);

  // Client-side sort of the current page only (server paginates)
  const sortedRides = useMemo(() => {
    if (!sort) return rides;
    const dir = sort.direction === 'asc' ? 1 : -1;
    const key = sort.columnId as keyof Ride;
    return [...rides].sort((a, b) => {
      const av = a[key] as unknown;
      const bv = b[key] as unknown;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [rides, sort]);

  const activeFilterCount = useMemo(
    () =>
      (Object.keys(filters) as (keyof AdvancedFilters)[]).reduce(
        (acc, k) => acc + (filters[k] ? 1 : 0),
        0,
      ) + (selectedCity ? 1 : 0),
    [filters, selectedCity],
  );

  const updateFilter = useCallback(<K extends keyof AdvancedFilters>(key: K, value: AdvancedFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(0);
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({ ...EMPTY_FILTERS });
    setSelectedCity('');
    setPage(0);
  }, []);

  const handleExportCsv = useCallback(() => {
    exportToCsv(
      sortedRides as unknown as Record<string, unknown>[],
      [
        { key: 'pickup_address', label: t('rides.csv_col_origin', { defaultValue: 'Origen' }) },
        { key: 'dropoff_address', label: t('rides.csv_col_destination', { defaultValue: 'Destino' }) },
        { key: 'status', label: t('rides.csv_col_status', { defaultValue: 'Estado' }) },
        { key: 'estimated_fare_cup', label: t('rides.csv_col_estimated_fare', { defaultValue: 'Tarifa estimada (CUP)' }) },
        { key: 'final_fare_cup', label: t('rides.csv_col_final_fare', { defaultValue: 'Tarifa final (CUP)' }) },
        { key: 'estimated_distance_m', label: t('rides.csv_col_estimated_distance', { defaultValue: 'Distancia estimada (m)' }) },
        { key: 'actual_distance_m', label: t('rides.csv_col_actual_distance', { defaultValue: 'Distancia real (m)' }) },
        { key: 'payment_method', label: t('rides.csv_col_payment_method', { defaultValue: 'Método de pago' }) },
        { key: 'created_at', label: t('rides.csv_col_created', { defaultValue: 'Creado' }) },
      ],
      'rides',
    );
  }, [sortedRides, t]);

  const columns: DataColumn<Ride>[] = [
    {
      id: 'pickup_address',
      header: t('rides.col_route', { defaultValue: 'Ruta' }),
      cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-ink">{truncate(r.pickup_address, 34)}</span>
          <span className="truncate text-[11.5px] text-ink-muted">
            → {truncate(r.dropoff_address, 34)}
          </span>
        </span>
      ),
      primary: true,
      cardLabel: t('rides.col_route_card', { defaultValue: 'Ruta' }),
    },
    {
      id: 'status',
      header: t('rides.col_status', { defaultValue: 'Estado' }),
      cell: (r) => <StatusBadge domain="ride" status={r.status} />,
      width: '170px',
      sortKey: 'status',
    },
    {
      id: 'fare',
      header: t('rides.col_fare', { defaultValue: 'Tarifa' }),
      cell: (r) => {
        if (r.final_fare_cup != null) {
          return (
            <span className="inline-flex items-baseline gap-1.5">
              <span className="font-medium text-ink">{formatCUP(r.final_fare_cup)}</span>
              {r.final_fare_cup !== r.estimated_fare_cup && (
                <span className="text-[10px] text-ink-subtle line-through">
                  {formatCUP(r.estimated_fare_cup)}
                </span>
              )}
            </span>
          );
        }
        return (
          <span className="text-ink-muted">
            {formatCUP(r.estimated_fare_cup)}{' '}
            <span className="text-[10px] text-ink-subtle">({t('rides.fare_estimated_suffix', { defaultValue: 'est.' })})</span>
          </span>
        );
      },
      align: 'right',
      mono: true,
      width: '160px',
      sortKey: 'estimated_fare_cup',
    },
    {
      id: 'distance',
      header: t('rides.col_distance', { defaultValue: 'Distancia' }),
      cell: (r) => {
        if (r.actual_distance_m != null) return `${(r.actual_distance_m / 1000).toFixed(1)} km`;
        if (r.estimated_distance_m > 0)
          return (
            <span className="text-ink-muted">
              {(r.estimated_distance_m / 1000).toFixed(1)} km{' '}
              <span className="text-[10px] text-ink-subtle">({t('rides.fare_estimated_suffix', { defaultValue: 'est.' })})</span>
            </span>
          );
        return '—';
      },
      align: 'right',
      mono: true,
      hideBelow: 'lg',
      width: '120px',
    },
    {
      id: 'payment_method',
      header: t('rides.col_payment', { defaultValue: 'Pago' }),
      cell: (r) =>
        r.payment_method === 'cash'
          ? t('rides.payment_cash', { defaultValue: 'Efectivo' })
          : t('rides.payment_tricicoin', { defaultValue: 'TriciCoin' }),
      hideBelow: 'lg',
      width: '110px',
    },
    {
      id: 'created_at',
      header: t('rides.col_date', { defaultValue: 'Creado' }),
      cell: (r) => <span className="text-ink-muted">{formatAdminDate(r.created_at)}</span>,
      sortKey: 'created_at',
      hideBelow: 'lg',
      width: '170px',
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Page header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('rides.page_eyebrow', { defaultValue: 'Operación · viajes' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('rides.title', { defaultValue: 'Viajes' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('rides.page_description', { defaultValue: 'Todas las solicitudes de viaje, en cualquier estado, en toda Cuba.' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedCity}
            onChange={(e) => {
              setSelectedCity(e.target.value);
              setPage(0);
            }}
            aria-label={t('rides.filter_by_city_aria', { defaultValue: 'Filtrar por ciudad' })}
            className="h-9 rounded-lg border border-line bg-surface px-3 text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
          >
            <option value="">{t('rides.all_cities', { defaultValue: 'Todas las ciudades' })}</option>
            {cities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={sortedRides.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            {t('rides.export_csv', { defaultValue: 'Exportar CSV' })}
          </button>
        </div>
      </div>

      <FilterBar<StatusFilter>
        sticky
        tabs={STATUS_TABS}
        activeTab={statusFilter}
        onTabChange={(id) => {
          setStatusFilter(id);
          setPage(0);
        }}
        search={{
          value: filters.search,
          onChange: (v) => updateFilter('search', v),
          placeholder: t('rides.search_address_placeholder', { defaultValue: 'Buscar por dirección…' }),
        }}
        activeFilterCount={activeFilterCount - (filters.search ? 1 : 0)}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
              {t('filters.service_type', { defaultValue: 'Tipo de servicio' })}
            </span>
            <select
              value={filters.serviceType}
              onChange={(e) => updateFilter('serviceType', e.target.value)}
              className="h-9 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
            >
              <option value="">{t('rides.type_all', { defaultValue: 'Todos' })}</option>
              <option value="triciclo_basico">{t('rides.type_triciclo', { defaultValue: 'Triciclo' })}</option>
              <option value="moto_standard">{t('rides.type_moto', { defaultValue: 'Moto' })}</option>
              <option value="auto_standard">{t('rides.type_auto', { defaultValue: 'Auto' })}</option>
              <option value="mensajeria">{t('rides.type_mensajeria', { defaultValue: 'Mensajería' })}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
              {t('filters.payment_method', { defaultValue: 'Método de pago' })}
            </span>
            <select
              value={filters.paymentMethod}
              onChange={(e) => updateFilter('paymentMethod', e.target.value)}
              className="h-9 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
            >
              <option value="">{t('rides.type_all', { defaultValue: 'Todos' })}</option>
              <option value="cash">{t('rides.payment_cash', { defaultValue: 'Efectivo' })}</option>
              <option value="tricicoin">{t('rides.payment_tricicoin', { defaultValue: 'TriciCoin' })}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
              {t('rides.filter_desde', { defaultValue: 'Desde' })}
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
              {t('rides.filter_hasta', { defaultValue: 'Hasta' })}
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
              {t('rides.clear_all', { defaultValue: 'Limpiar todo' })}
            </button>
          </div>
        )}
      </FilterBar>

      <DataTable<Ride>
        columns={columns}
        rows={sortedRides}
        keyField="id"
        loading={loading}
        error={error}
        onRetry={() => {
          setError(null);
          void fetchRides();
        }}
        empty={
          activeFilterCount > 0 || statusFilter !== 'all'
            ? {
                icon: Search,
                title: t('rides.empty_filtered_title', { defaultValue: 'Sin viajes que coincidan' }),
                body: t('rides.empty_filtered_body', { defaultValue: 'Probá limpiar los filtros o elegir otra pestaña.' }),
                action: {
                  label: t('rides.empty_filtered_action', { defaultValue: 'Limpiar filtros' }),
                  onClick: clearFilters,
                },
              }
            : {
                icon: Route,
                title: t('rides.empty_zero_title', { defaultValue: 'Cuba duerme tranquila' }),
                body: t('rides.empty_zero_body', { defaultValue: 'Aún no hay viajes registrados. Cuando lleguen, los verás acá en tiempo real.' }),
              }
        }
        rowHref={(r) => `/rides/${r.id}`}
        sort={sort}
        onSortChange={setSort}
        pagination={{
          page,
          pageSize: PAGE_SIZE,
          hasMore: rides.length === PAGE_SIZE,
        }}
        onPaginationChange={(next) => setPage(next.page)}
      />
    </div>
  );
}
