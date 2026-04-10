'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { adminService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { User } from '@tricigo/types';
import { formatAdminDate } from '@/lib/formatDate';
import type { UserRole } from '@tricigo/types';
import { FilterPanel, type FilterField } from '@/components/FilterPanel';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { useSortableTable } from '@/hooks/useSortableTable';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { exportToCsv } from '@/lib/exportCsv';

const PAGE_SIZE = 20;

const ROLE_FILTERS: { labelKey: string; value: UserRole | 'all' }[] = [
  { labelKey: 'users.filter_all', value: 'all' },
  { labelKey: 'users.filter_customer', value: 'customer' },
  { labelKey: 'users.filter_driver', value: 'driver' },
  { labelKey: 'users.filter_admin', value: 'admin' },
];

const roleBadgeClasses: Record<UserRole, string> = {
  customer: 'bg-blue-50 text-blue-700',
  driver: 'bg-amber-50 text-amber-700',
  admin: 'bg-purple-50 text-purple-700',
  super_admin: 'bg-red-50 text-red-700',
};

const EMPTY_FILTERS: Record<string, string> = {
  search: '',
  dateFrom: '',
  dateTo: '',
  isActive: '',
};

export default function UsersPage() {
  const router = useRouter();
  const { t } = useTranslation('admin');
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [roleFilter, setRoleFilter] = useState<UserRole | 'all'>('all');
  const [advancedFilters, setAdvancedFilters] = useState<Record<string, string>>({ ...EMPTY_FILTERS });

  const filterFields: FilterField[] = [
    {
      key: 'search',
      label: t('filters.search'),
      type: 'text',
      placeholder: t('filters.search_user_placeholder'),
    },
    { key: 'dateFrom', label: t('filters.date_from'), type: 'date' },
    { key: 'dateTo', label: t('filters.date_to'), type: 'date' },
    {
      key: 'isActive',
      label: t('filters.status'),
      type: 'select',
      placeholder: t('filters.all'),
      options: [
        { label: t('common.active'), value: 'true' },
        { label: t('common.inactive'), value: 'false' },
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

    async function fetchUsers() {
      try {
        const filters: Record<string, any> = {};
        if (roleFilter !== 'all') filters.role = roleFilter;
        if (advancedFilters.search) filters.search = advancedFilters.search;
        if (advancedFilters.dateFrom) filters.dateFrom = advancedFilters.dateFrom;
        if (advancedFilters.dateTo) filters.dateTo = advancedFilters.dateTo;
        if (advancedFilters.isActive) filters.isActive = advancedFilters.isActive === 'true';

        const data = await adminService.getUsers(page, PAGE_SIZE, filters);
        if (!cancelled) setUsers(data);
      } catch (err) {
        // Error handled by UI
        if (!cancelled) { setUsers([]); setError(err instanceof Error ? err.message : 'Error al cargar usuarios'); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchUsers();
    return () => { cancelled = true; };
  }, [page, roleFilter, advancedFilters]);

  const { sortedData, toggleSort, sortKey, sortDirection } = useSortableTable(users, 'created_at');

  const canGoPrev = page > 0;
  // Heuristic: if we got exactly PAGE_SIZE items, there may be more pages.
  // This can show a false "next" on the last page when items are exactly PAGE_SIZE,
  // but it's an acceptable trade-off to avoid an extra count query.
  const canGoNext = users.length === PAGE_SIZE;

  function handleExportCsv() {
    exportToCsv(
      sortedData as unknown as Record<string, unknown>[],
      [
        { key: 'full_name', label: t('users.col_name') },
        { key: 'phone', label: t('users.col_phone') },
        { key: 'email', label: 'Email' },
        { key: 'role', label: t('users.col_role') },
        { key: 'is_active', label: t('users.col_status'), format: (v) => v ? 'Active' : 'Inactive' },
        { key: 'created_at', label: t('users.col_registered') },
      ],
      'users',
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">{t('users.title')}</h1>
        <button
          onClick={handleExportCsv}
          disabled={sortedData.length === 0}
          className="px-3 py-1.5 rounded-lg text-sm border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {t('common.export_csv', { defaultValue: 'Export CSV' })}
        </button>
      </div>

      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); setPage(0); }}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Role filter buttons */}
      <div className="flex flex-wrap gap-2 mb-4">
        {ROLE_FILTERS.map((filter) => (
          <button
            key={filter.value}
            onClick={() => { setRoleFilter(filter.value); setPage(0); }}
            aria-pressed={roleFilter === filter.value}
            aria-label={t(filter.labelKey)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              roleFilter === filter.value
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

      {/* Users table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full" aria-label={t('users.title')}>
          <thead>
            <tr className="border-b border-neutral-100">
              <SortableHeader label={t('users.col_name')} sortKey="full_name" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap" />
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap hidden lg:table-cell">
                {t('users.col_phone')}
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                {t('users.col_role')}
              </th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                {t('users.col_status')}
              </th>
              <SortableHeader label={t('users.col_registered')} sortKey="created_at" currentSortKey={sortKey as string | null} sortDirection={sortDirection} onSort={toggleSort as (key: string) => void} className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap hidden lg:table-cell" />
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                {t('common.actions')}
              </th>
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
                <td colSpan={6} className="text-center py-12 text-neutral-500 dark:text-neutral-400">
                  {t('users.no_users')}
                </td>
              </tr>
            ) : (
              sortedData.map((user) => (
                <tr
                  key={user.id}
                  className="border-b border-neutral-50 hover:bg-neutral-50 transition-colors cursor-pointer"
                  onClick={() => router.push(`/users/${user.id}`)}
                >
                  <td className="px-6 py-4 text-sm text-neutral-900 font-medium">
                    {user.full_name}
                  </td>
                  <td className="px-6 py-4 text-sm text-neutral-600 hidden lg:table-cell">
                    {user.phone}
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        roleBadgeClasses[user.role] ?? 'bg-neutral-100 text-neutral-600'
                      }`}
                    >
                      {user.role}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        user.is_active
                          ? 'bg-green-50 text-green-700'
                          : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {user.is_active ? t('common.active') : t('common.inactive')}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-neutral-600 hidden lg:table-cell">
                    {formatAdminDate(user.created_at)}
                  </td>
                  <td className="px-6 py-4">
                    <Link
                      href={`/users/${user.id}`}
                      className="text-sm font-medium text-primary-500 hover:text-primary-600 transition-colors"
                    >
                      {t('common.view')}
                    </Link>
                  </td>
                </tr>
              ))
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
        <span className="text-sm text-neutral-500" aria-live="polite">
          {t('common.page')} {page + 1}
        </span>
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
