'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { Ride, RideStatus } from '@tricigo/types';

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

export default function RidesPage() {
  const router = useRouter();
  const { t } = useTranslation('admin');
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function fetchRides() {
      try {
        const filters = statusFilter === 'all' ? {} : { status: statusFilter };
        const data = await adminService.getRides(filters, page, PAGE_SIZE);
        if (!cancelled) setRides(data);
      } catch (err) {
        console.error('Error fetching rides:', err);
        if (!cancelled) setRides([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchRides();
    return () => { cancelled = true; };
  }, [page, statusFilter]);

  const canGoPrev = page > 0;
  const canGoNext = rides.length === PAGE_SIZE;

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">{t('rides.title')}</h1>

      {/* Status filter tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            onClick={() => { setStatusFilter(filter.value); setPage(0); }}
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

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-100">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('rides.col_route')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('rides.col_status')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('rides.col_fare')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('rides.col_distance')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('rides.col_payment')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('rides.col_date')}</th>
            </tr>
          </thead>
          <tbody>
            {rides.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-12 text-neutral-400">
                  {loading ? t('common.loading') : t('rides.no_rides')}
                </td>
              </tr>
            ) : (
              rides.map((ride) => (
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
                  <td className="px-4 py-3 text-neutral-500">
                    {ride.actual_distance_m != null
                      ? `${(ride.actual_distance_m / 1000).toFixed(1)} km`
                      : ride.estimated_distance_m > 0
                        ? <span className="text-neutral-400">{(ride.estimated_distance_m / 1000).toFixed(1)} km ({t('rides.estimated')})</span>
                        : '—'}
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {ride.payment_method === 'cash' ? t('rides.payment_cash') : t('rides.payment_tricicoin')}
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {new Date(ride.created_at).toLocaleDateString('es-CU', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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
