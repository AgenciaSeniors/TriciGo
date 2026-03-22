'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { Ride } from '@tricigo/types';
import { FilterPanel, type FilterField } from '@/components/FilterPanel';
import { createBrowserClient } from '@/lib/supabase-server';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { useSortableTable } from '@/hooks/useSortableTable';
import { SortableHeader } from '@/components/ui/SortableHeader';

const PAGE_SIZE = 20;

const STATUS_FILTERS = [
  { labelKey: 'rides.filter_all', value: 'all' },
  { labelKey: 'rides.filter_searching', value: 'searching' },
  { labelKey: 'rides.filter_accepted', value: 'accepted' },
  { labelKey: 'rides.filter_in_progress', value: 'in_progress' },
  { labelKey: 'rides.filter_completed', value: 'completed' },
  { labelKey: 'rides.filter_canceled', value: 'canceled' },
  { labelKey: 'rides.filter_disputed', value: 'disputed' },
] as const;

const STATUS_BADGE: Record<string, string> = {
  searching: 'bg-yellow-100 text-yellow-700',
  accepted: 'bg-blue-100 text-blue-700',
  driver_en_route: 'bg-blue-100 text-blue-700',
  arrived_at_pickup: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  canceled: 'bg-red-100 text-red-700',
  disputed: 'bg-orange-100 text-orange-700',
};

const STATUS_LABEL_KEY: Record<string, string> = {
  searching: 'rides.status_searching',
  accepted: 'rides.status_accepted',
  driver_en_route: 'rides.status_driver_en_route',
  arrived_at_pickup: 'rides.status_arrived_at_pickup',
  in_progress: 'rides.status_in_progress',
  completed: 'rides.status_completed',
  canceled: 'rides.status_canceled',
  disputed: 'rides.status_disputed',
};

function truncate(str: string, len: number) {
  return str.length > len ? str.slice(0, len) + '…' : str;
}

const EMPTY_FILTERS: Record<string, string> = {
  serviceType: '',
  paymentMethod: '',
  dateFrom: '',
  dateTo: '',
  search: '',
};

export default function RidesPage() {
  const router = useRouter();
  const { t } = useTranslation('admin');
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [advancedFilters, setAdvancedFilters] = useState<Record<string, string>>({ ...EMPTY_FILTERS });
  const [cities, setCities] = useState<{id: string, name: string}[]>([]);
  const [selectedCity, setSelectedCity] = useState<string>('');

  useEffect(() => {
    const supabase = createBrowserClient();
    supabase.from('cities').select('id, name').eq('is_active', true).order('name')
      .then(({ data }) => { if (data) setCities(data); });
  }, []);

  const filterFields: FilterField[] = [
    {
      key: 'search',
      label: t('filters.search'),
      type: 'text',
      placeholder: t('filters.search_address_placeholder'),
    },
    {
      key: 'serviceType',
      label: t('filters.service_type'),
      type: 'select',
      placeholder: t('filters.all'),
      options: [
        { label: t('rides.filter_triciclo'), value: 'triciclo_basico' },
        { label: t('rides.filter_moto'), value: 'moto_standard' },
        { label: t('rides.filter_auto'), value: 'auto_standard' },
        { label: t('rides.filter_mensajeria'), value: 'mensajeria' },
      ],
    },
    {
      key: 'paymentMethod',
      label: t('filters.payment_method'),
      type: 'select',
      placeholder: t('filters.all'),
      options: [
        { label: t('rides.payment_cash'), value: 'cash' },
        { label: t('rides.payment_tricicoin'), value: 'tricicoin' },
        { label: 'TropiPay', value: 'tropipay' },
      ],
    },
    { key: 'dateFrom', label: t('filters.date_from'), type: 'date' },
    { key: 'dateTo', label: t('filters.date_to'), type: 'date' },
  ];

  const handleFilterChange = useCallback((key: string, value: string) => {
    setAdvancedFilters((prev) => ({ ...prev, [key]: value }));
    setPage(0);
  }, []);

  const handleClearFilters = useCallback(() => {
    setAdvancedFilters({ ...EMPTY_FILTERS });
    setPage(0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function fetchRides() {
      try {
        const filters: Record<string, string> = {};
        if (statusFilter !== 'all') filters.status = statusFilter;
        if (advancedFilters.serviceType) filters.serviceType = advancedFilters.serviceType;
        if (advancedFilters.paymentMethod) filters.paymentMethod = advancedFilters.paymentMethod;
        if (advancedFilters.dateFrom) filters.dateFrom = advancedFilters.dateFrom;
        if (advancedFilters.dateTo) filters.dateTo = advancedFilters.dateTo;
        if (advancedFilters.search) filters.search = advancedFilters.search;
        if (selectedCity) filters.cityId = selectedCity;

        const data = await adminService.getRides(filters, page, PAGE_SIZE);
        if (!cancelled) setRides(data);
      } catch (err) {
        console.error('Error fetching rides:', err);
        if (!cancelled) { setRides([]); setError(err instanceof Error ? err.message : 'Error al cargar viajes'); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchRides();
    return () => { cancelled = true; };
  }, [page, statusFilter, advancedFilters, selectedCity]);

  const { sortedData, toggleSort, sortKey, sortDirection } = useSortableTable(rides, 'created_at');

  const canGoPrev = page > 0;
  const canGoNext = rides.length === PAGE_SIZE;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">{t('rides.title')}</h1>
        <select
          value={selectedCity}
          onChange={(e) => { setSelectedCity(e.target.value); setPage(0); }}
          className="px-3 py-1.5 rounded-lg text-sm border border-neutral-200 bg-white text-neutral-700"
        >
          <option value="">{t('cities.all_cities')}</option>
          {cities.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); setPage(0); }}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Status filter tabs */}
      <div className="flex flex-wrap gap-2 mb-4">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            onClick={() => { setStatusFilter(filter.value); setPage(0); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === filter.value
                ? 'bg-primary-500 text-white'
                : 'bg-white text-neutral-600 border border-neutral-200 hover:border-neutral-300'
            }`}
          >
            {t(filter.labelKey)}
          </button>
        ))}
      </div>

      {/* Advanced filters */}
      <FilterPanel
        fields={filterFields}
        values={advancedFilters}
        onChange={handleFilterChange}
        onClear={handleClearFilters}
        clearLabel={t('filters.clear_all')}
        toggleLabel={t('filters.advanced_filters')}
      />

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-100">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap">{t('rides.col_route')}</th>
              <SortableHeader label={t('rides.col_status')} sortKey="status" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap" />
              <SortableHeader label={t('rides.col_fare')} sortKey="estimated_fare_cup" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap" />
              <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap hidden lg:table-cell">{t('rides.col_distance')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap hidden lg:table-cell">{t('rides.col_payment')}</th>
              <SortableHeader label={t('rides.col_date')} sortKey="created_at" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap hidden lg:table-cell" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-0 py-0">
                  <AdminTableSkeleton rows={5} columns={6} />
                </td>
              </tr>
            ) : sortedData.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-12 text-neutral-400">
                  {t('rides.no_rides')}
                </td>
              </tr>
            ) : (
              sortedData.map((ride) => (
                <tr key={ride.id} className="border-b border-neutral-50 hover:bg-neutral-50 cursor-pointer" onClick={() => router.push(`/rides/${ride.id}`)}>
                  <td className="px-4 py-3">
                    <div className="text-neutral-900">{truncate(ride.pickup_address, 25)}</div>
                    <div className="text-neutral-500 text-xs">→ {truncate(ride.dropoff_address, 25)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[ride.status] ?? 'bg-neutral-100 text-neutral-700'}`}>
                      {STATUS_LABEL_KEY[ride.status] ? t(STATUS_LABEL_KEY[ride.status]!) : ride.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {ride.final_fare_cup != null ? (
                      <>
                        <span>{formatCUP(ride.final_fare_cup)}</span>
                        {ride.final_fare_cup !== ride.estimated_fare_cup && (
                          <span className="text-xs text-neutral-400 ml-1 line-through">
                            {formatCUP(ride.estimated_fare_cup)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-neutral-400">{formatCUP(ride.estimated_fare_cup)} ({t('rides.estimated')})</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-neutral-500 hidden lg:table-cell">
                    {ride.actual_distance_m != null
                      ? `${(ride.actual_distance_m / 1000).toFixed(1)} km`
                      : ride.estimated_distance_m > 0
                        ? <span className="text-neutral-400">{(ride.estimated_distance_m / 1000).toFixed(1)} km ({t('rides.estimated')})</span>
                        : '—'}
                  </td>
                  <td className="px-4 py-3 text-neutral-500 hidden lg:table-cell">
                    {ride.payment_method === 'cash' ? t('rides.payment_cash') : t('rides.payment_tricicoin')}
                  </td>
                  <td className="px-4 py-3 text-neutral-500 hidden lg:table-cell">
                    {new Date(ride.created_at).toLocaleDateString('es-CU', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4">
        <button
          onClick={() => setPage((p) => p - 1)}
          disabled={!canGoPrev}
          className="px-4 py-2 rounded-lg text-sm border border-neutral-200 disabled:opacity-30"
        >
          {t('common.previous')}
        </button>
        <span className="text-sm text-neutral-500">
          {t('common.page')} <strong>{page + 1}</strong>
        </span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={!canGoNext}
          className="px-4 py-2 rounded-lg text-sm border border-neutral-200 disabled:opacity-30"
        >
          {t('common.next')}
        </button>
      </div>
    </div>
  );
}
