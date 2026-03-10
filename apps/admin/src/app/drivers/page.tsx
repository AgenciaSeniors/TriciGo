'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { DriverProfileWithUser } from '@tricigo/types';
import type { DriverStatus } from '@tricigo/types';

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

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('es-CU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function DriversPage() {
  const { t } = useTranslation('admin');
  const [drivers, setDrivers] = useState<DriverProfileWithUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  useEffect(() => {
    let cancelled = false;

    async function fetchDrivers() {
      setLoading(true);
      try {
        const data =
          statusFilter === 'all'
            ? await adminService.getAllDrivers(page, PAGE_SIZE)
            : await adminService.getDriversByStatus(statusFilter, page, PAGE_SIZE);
        if (!cancelled) setDrivers(data);
      } catch (err) {
        console.error('Error fetching drivers:', err);
        if (!cancelled) setDrivers([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDrivers();
    return () => {
      cancelled = true;
    };
  }, [page, statusFilter]);

  const canGoPrev = page > 0;
  const canGoNext = drivers.length === PAGE_SIZE;

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">{t('drivers.title')}</h1>

      {/* Status filter tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            onClick={() => {
              setStatusFilter(filter.value);
              setPage(0);
            }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === filter.value
                ? 'bg-[#FF4D00] text-white'
                : 'bg-white text-neutral-600 border border-neutral-200 hover:border-neutral-300'
            }`}
          >
            {t(filter.labelKey)}
          </button>
        ))}
      </div>

      {/* Drivers table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-neutral-100">
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">{t('drivers.col_name')}</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">{t('drivers.col_phone')}</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">{t('drivers.col_vehicle')}</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">{t('drivers.col_status')}</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">{t('drivers.col_rating')}</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">{t('drivers.col_registered')}</th>
              <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-neutral-400">
                  {t('common.loading')}
                </td>
              </tr>
            ) : drivers.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-neutral-400">
                  {t('drivers.no_drivers')}
                </td>
              </tr>
            ) : (
              drivers.map((driver) => {
                const vehicle = driver.vehicles?.[0];
                return (
                  <tr
                    key={driver.id}
                    className="border-b border-neutral-50 hover:bg-neutral-50/50 transition-colors"
                  >
                    <td className="px-6 py-4 text-sm text-neutral-900 font-medium">
                      {driver.users.full_name || '—'}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600">
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
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600">
                      {Number(driver.rating_avg).toFixed(1)}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-600">
                      {formatDate(driver.created_at)}
                    </td>
                    <td className="px-6 py-4">
                      <Link
                        href={`/drivers/${driver.id}`}
                        className="text-sm font-medium text-[#FF4D00] hover:text-[#e04400] transition-colors"
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

      {/* Pagination */}
      <div className="flex items-center justify-between mt-6">
        <button
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={!canGoPrev}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            canGoPrev
              ? 'bg-white text-neutral-700 border border-neutral-200 hover:border-neutral-300'
              : 'bg-neutral-50 text-neutral-300 border border-neutral-100 cursor-not-allowed'
          }`}
        >
          {t('common.previous')}
        </button>
        <span className="text-sm text-neutral-500">{t('common.page')} {page + 1}</span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={!canGoNext}
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
