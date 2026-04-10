'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { adminService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { DriverProfileWithUser } from '@tricigo/types';
import { formatAdminDate } from '@/lib/formatDate';
import type { DriverStatus } from '@tricigo/types';
import { FilterPanel, type FilterField } from '@/components/FilterPanel';
import { createBrowserClient } from '@/lib/supabase-server';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { useSortableTable } from '@/hooks/useSortableTable';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { exportToCsv } from '@/lib/exportCsv';

const PAGE_SIZE = 20;

type StatusFilter = DriverStatus | 'all';

const STATUS_FILTERS: { labelKey: string; value: StatusFilter }[] = [
  { labelKey: 'drivers.filter_all', value: 'all' },
  { labelKey: 'drivers.filter_pending', value: 'pending_verification' },
  { labelKey: 'drivers.filter_in_review', value: 'under_review' },
  { labelKey: 'drivers.filter_approved', value: 'approved' },
  { labelKey: 'drivers.filter_rejected', value: 'rejected' },
  { labelKey: 'drivers.filter_suspended', value: 'suspended' },
];

const statusBadgeClasses: Record<DriverStatus, string> = {
  pending_verification: 'bg-yellow-50 text-yellow-700',
  under_review: 'bg-blue-50 text-blue-700',
  approved: 'bg-green-50 text-green-700',
  rejected: 'bg-red-50 text-red-700',
  suspended: 'bg-orange-50 text-orange-700',
};

const statusLabelKeys: Record<DriverStatus, string> = {
  pending_verification: 'drivers.status_pending',
  under_review: 'drivers.status_in_review',
  approved: 'drivers.status_approved',
  rejected: 'drivers.status_rejected',
  suspended: 'drivers.status_suspended',
};

const EMPTY_FILTERS: Record<string, string> = {
  search: '',
  ratingMin: '',
  vehicleType: '',
};

export default function DriversPage() {
  const router = useRouter();
  const { t } = useTranslation('admin');
  const [drivers, setDrivers] = useState<DriverProfileWithUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
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
      placeholder: t('filters.search_driver_placeholder'),
    },
    {
      key: 'ratingMin',
      label: t('filters.rating_min'),
      type: 'select',
      placeholder: t('filters.all'),
      options: [
        { label: '4.0+', value: '4.0' },
        { label: '4.5+', value: '4.5' },
        { label: '3.0+', value: '3.0' },
      ],
    },
    {
      key: 'vehicleType',
      label: t('filters.vehicle_type'),
      type: 'select',
      placeholder: t('filters.all'),
      options: [
        { label: t('drivers.type_triciclo'), value: 'triciclo' },
        { label: t('drivers.type_moto'), value: 'moto' },
        { label: t('drivers.type_auto'), value: 'auto' },
      ],
    },
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

    async function fetchDrivers() {
      try {
        const filters: Record<string, any> = {};
        if (statusFilter !== 'all') filters.status = statusFilter;
        if (advancedFilters.search) filters.search = advancedFilters.search;
        if (advancedFilters.ratingMin) filters.ratingMin = parseFloat(advancedFilters.ratingMin);
        if (advancedFilters.vehicleType) filters.vehicleType = advancedFilters.vehicleType;
        if (selectedCity) filters.cityId = selectedCity;

        const data = await adminService.getAllDrivers(page, PAGE_SIZE, filters);
        if (!cancelled) setDrivers(data);
      } catch (err) {
        // Error handled by UI
        if (!cancelled) { setDrivers([]); setError(err instanceof Error ? err.message : 'Error al cargar conductores'); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDrivers();
    return () => { cancelled = true; };
  }, [page, statusFilter, advancedFilters, selectedCity]);

  const { sortedData, toggleSort, sortKey, sortDirection } = useSortableTable(drivers, 'created_at');

  const canGoPrev = page > 0;
  // Heuristic: if we got exactly PAGE_SIZE items, there may be more pages.
  // This can show a false "next" on the last page when items are exactly PAGE_SIZE,
  // but it's an acceptable trade-off to avoid an extra count query.
  const canGoNext = drivers.length === PAGE_SIZE;

  return (
    <div>
      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); setPage(0); }}
          onDismiss={() => setError(null)}
        />
      )}

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">{t('drivers.title')}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              exportToCsv(
                sortedData.map((d) => ({
                  ...d,
                  name: d.users?.full_name ?? '',
                  phone: d.users?.phone ?? '',
                  vehicle: d.vehicles?.[0] ? `${d.vehicles[0].type} — ${d.vehicles[0].plate_number}` : '',
                })) as unknown as Record<string, unknown>[],
                [
                  { key: 'name', label: t('drivers.col_name') },
                  { key: 'phone', label: t('drivers.col_phone') },
                  { key: 'vehicle', label: t('drivers.col_vehicle') },
                  { key: 'status', label: t('drivers.col_status') },
                  { key: 'rating_avg', label: t('drivers.col_rating') },
                  { key: 'created_at', label: t('drivers.col_registered') },
                ],
                'drivers',
              );
            }}
            disabled={sortedData.length === 0}
            className="px-3 py-1.5 rounded-lg text-sm border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {t('common.export_csv', { defaultValue: 'Export CSV' })}
          </button>
          <select
            value={selectedCity}
            onChange={(e) => { setSelectedCity(e.target.value); setPage(0); }}
            aria-label={t('cities.filter_by_city', { defaultValue: 'Filter by city' })}
            className="px-3 py-1.5 rounded-lg text-sm border border-neutral-200 bg-white text-neutral-700"
          >
            <option value="">{t('cities.all_cities')}</option>
            {cities.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Status filter tabs */}
      <div className="flex flex-wrap gap-2 mb-4">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            onClick={() => {
              setStatusFilter(filter.value);
              setPage(0);
            }}
            aria-pressed={statusFilter === filter.value}
            aria-label={t(filter.labelKey)}
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

      {/* Drivers table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full" aria-label={t('drivers.title')}>
          <thead>
            <tr className="border-b border-neutral-100">
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">{t('drivers.col_name')}</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap hidden lg:table-cell">{t('drivers.col_phone')}</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">{t('drivers.col_vehicle')}</th>
              <SortableHeader label={t('drivers.col_status')} sortKey="status" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap" />
              <SortableHeader label={t('drivers.col_rating')} sortKey="rating_avg" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap hidden lg:table-cell" />
              <SortableHeader label={t('drivers.col_registered')} sortKey="created_at" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap hidden lg:table-cell" />
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-0 py-0">
                  <AdminTableSkeleton rows={5} columns={7} />
                </td>
              </tr>
            ) : sortedData.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-neutral-400">
                  {t('drivers.no_drivers')}
                </td>
              </tr>
            ) : (
              sortedData.map((driver) => {
                const vehicle = driver.vehicles?.[0];
                return (
                  <tr
                    key={driver.id}
                    className="border-b border-neutral-50 hover:bg-neutral-50 transition-colors cursor-pointer"
                    onClick={() => router.push(`/drivers/${driver.id}`)}
                  >
                    <td className="px-6 py-4 text-sm text-neutral-900 font-medium">
                      {driver.users.full_name || '—'}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600 hidden lg:table-cell">
                      {driver.users.phone}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600">
                      {vehicle ? `${vehicle.type} — ${vehicle.plate_number}` : '—'}
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          statusBadgeClasses[driver.status]
                        }`}
                      >
                        {t(statusLabelKeys[driver.status])}
                      </span>
                      {(driver as any).is_on_break && (
                        <span className="inline-block ml-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700">
                          {t('drivers.on_break', { defaultValue: 'En descanso' })}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600 hidden lg:table-cell">
                      {Number(driver.rating_avg).toFixed(1)}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600 hidden lg:table-cell">
                      {formatAdminDate(driver.created_at)}
                    </td>
                    <td className="px-6 py-4">
                      <Link
                        href={`/drivers/${driver.id}`}
                        className="text-sm font-medium text-primary-500 hover:text-primary-600 transition-colors"
                      >
                        {t('common.view_detail')}
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-6">
        <button
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={!canGoPrev}
          aria-label={t('common.previous')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            canGoPrev
              ? 'bg-white text-neutral-700 border border-neutral-200 hover:border-neutral-300'
              : 'bg-neutral-50 text-neutral-300 border border-neutral-100 cursor-not-allowed'
          }`}
        >
          {t('common.previous')}
        </button>
        <span className="text-sm text-neutral-500" aria-live="polite">{t('common.page')} {page + 1}</span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={!canGoNext}
          aria-label={t('common.next')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            canGoNext
              ? 'bg-white text-neutral-700 border border-neutral-200 hover:border-neutral-300'
              : 'bg-neutral-50 text-neutral-300 border border-neutral-100 cursor-not-allowed'
          }`}
        >
          {t('common.next')}
        </button>
      </div>
    </div>
  );
}
