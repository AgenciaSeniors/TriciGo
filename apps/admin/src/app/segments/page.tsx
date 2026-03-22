'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient } from '@tricigo/api';
import { cityService } from '@tricigo/api';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { AdminEmptyState } from '@/components/ui/AdminEmptyState';
import { formatAdminDate } from '@/lib/formatDate';

type SegmentType = 'new_users' | 'power_users' | 'inactive' | 'by_city';

type SegmentUser = {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  rides_count: number;
  last_ride_date: string | null;
  city_name: string | null;
};

type City = { id: string; name: string; slug: string };

const PAGE_SIZE = 20;

export default function SegmentsPage() {
  const { t } = useTranslation('admin');
  const [error, setError] = useState<string | null>(null);

  const [counts, setCounts] = useState<Record<SegmentType, number>>({
    new_users: 0,
    power_users: 0,
    inactive: 0,
    by_city: 0,
  });
  const [countsLoading, setCountsLoading] = useState(true);

  const [activeSegment, setActiveSegment] = useState<SegmentType | null>(null);
  const [users, setUsers] = useState<SegmentUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [page, setPage] = useState(0);

  const [cities, setCities] = useState<City[]>([]);
  const [selectedCityId, setSelectedCityId] = useState<string>('');

  // Load cities on mount
  useEffect(() => {
    cityService.getAllCities().then(setCities).catch(() => {});
  }, []);

  // Load segment counts
  useEffect(() => {
    loadCounts();
  }, []);

  const loadCounts = async () => {
    setCountsLoading(true);
    try {
      const supabase = getSupabaseClient();
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

      // New users (registered < 7 days)
      const { count: newCount } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', sevenDaysAgo);

      // Power users (>10 rides) — count profiles that have more than 10 rides
      const { data: powerData } = await supabase.rpc('count_power_users', {}).maybeSingle();
      // Fallback: query rides grouped by customer_id
      let powerCount = powerData?.count ?? 0;
      if (!powerData) {
        const { data: rideGroups } = await supabase
          .from('rides')
          .select('customer_id')
          .not('customer_id', 'is', null);
        if (rideGroups) {
          const rideCounts: Record<string, number> = {};
          for (const r of rideGroups) {
            rideCounts[r.customer_id] = (rideCounts[r.customer_id] || 0) + 1;
          }
          powerCount = Object.values(rideCounts).filter((c) => c > 10).length;
        }
      }

      // Inactive users (no ride in 30 days): get users whose last ride < 30 days ago or no rides
      const { data: activeRiders } = await supabase
        .from('rides')
        .select('customer_id')
        .gte('created_at', thirtyDaysAgo)
        .not('customer_id', 'is', null);
      const activeRiderIds = new Set((activeRiders ?? []).map((r) => r.customer_id));
      const { count: totalCustomers } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('role', 'customer');
      const inactiveCount = (totalCustomers ?? 0) - activeRiderIds.size;

      setCounts({
        new_users: newCount ?? 0,
        power_users: powerCount,
        inactive: Math.max(0, inactiveCount),
        by_city: 0,
      });
    } catch (err) {
      // Error handled by UI
      setError(err instanceof Error ? err.message : 'Error al cargar segmentos');
    } finally {
      setCountsLoading(false);
    }
  };

  const loadSegmentUsers = useCallback(
    async (segment: SegmentType, pageNum: number, cityId?: string) => {
      setUsersLoading(true);
      try {
        const supabase = getSupabaseClient();
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const offset = pageNum * PAGE_SIZE;

        let userIds: string[] = [];

        if (segment === 'new_users') {
          const { data } = await supabase
            .from('profiles')
            .select('id')
            .gte('created_at', sevenDaysAgo)
            .range(offset, offset + PAGE_SIZE - 1);
          userIds = (data ?? []).map((u) => u.id);
        } else if (segment === 'power_users') {
          // Get all rides, group by customer_id, filter >10
          const { data: allRides } = await supabase
            .from('rides')
            .select('customer_id')
            .not('customer_id', 'is', null);
          if (allRides) {
            const rideCounts: Record<string, number> = {};
            for (const r of allRides) {
              rideCounts[r.customer_id] = (rideCounts[r.customer_id] || 0) + 1;
            }
            userIds = Object.entries(rideCounts)
              .filter(([, c]) => c > 10)
              .map(([id]) => id)
              .slice(offset, offset + PAGE_SIZE);
          }
        } else if (segment === 'inactive') {
          const { data: activeRiders } = await supabase
            .from('rides')
            .select('customer_id')
            .gte('created_at', thirtyDaysAgo)
            .not('customer_id', 'is', null);
          const activeSet = new Set((activeRiders ?? []).map((r) => r.customer_id));
          const { data: allCustomers } = await supabase
            .from('profiles')
            .select('id')
            .eq('role', 'customer');
          const inactiveIds = (allCustomers ?? [])
            .filter((u) => !activeSet.has(u.id))
            .map((u) => u.id);
          userIds = inactiveIds.slice(offset, offset + PAGE_SIZE);
        } else if (segment === 'by_city' && cityId) {
          const { data } = await supabase
            .from('profiles')
            .select('id')
            .eq('city_id', cityId)
            .range(offset, offset + PAGE_SIZE - 1);
          userIds = (data ?? []).map((u) => u.id);
        }

        if (userIds.length === 0) {
          setUsers([]);
          setUsersLoading(false);
          return;
        }

        // Fetch profile details for these users
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, email, phone, city_id')
          .in('id', userIds);

        // Fetch ride counts and last ride per user
        const { data: rides } = await supabase
          .from('rides')
          .select('customer_id, created_at')
          .in('customer_id', userIds);

        const rideStats: Record<string, { count: number; lastRide: string | null }> = {};
        for (const ride of rides ?? []) {
          if (!rideStats[ride.customer_id]) {
            rideStats[ride.customer_id] = { count: 0, lastRide: null };
          }
          rideStats[ride.customer_id].count++;
          if (
            !rideStats[ride.customer_id].lastRide ||
            ride.created_at > rideStats[ride.customer_id].lastRide!
          ) {
            rideStats[ride.customer_id].lastRide = ride.created_at;
          }
        }

        // Get city names
        const cityIds = [...new Set((profiles ?? []).map((p) => p.city_id).filter(Boolean))];
        let cityMap: Record<string, string> = {};
        if (cityIds.length > 0) {
          const { data: citiesData } = await supabase
            .from('cities')
            .select('id, name')
            .in('id', cityIds);
          for (const c of citiesData ?? []) {
            cityMap[c.id] = c.name;
          }
        }

        const result: SegmentUser[] = (profiles ?? []).map((p) => ({
          id: p.id,
          full_name: p.full_name,
          email: p.email,
          phone: p.phone,
          rides_count: rideStats[p.id]?.count ?? 0,
          last_ride_date: rideStats[p.id]?.lastRide ?? null,
          city_name: p.city_id ? cityMap[p.city_id] ?? null : null,
        }));

        setUsers(result);
      } catch (err) {
        // Error handled by UI
        setUsers([]);
      } finally {
        setUsersLoading(false);
      }
    },
    [],
  );

  const handleViewUsers = (segment: SegmentType) => {
    setActiveSegment(segment);
    setPage(0);
    if (segment === 'by_city' && !selectedCityId) return;
    loadSegmentUsers(segment, 0, selectedCityId);
  };

  useEffect(() => {
    if (activeSegment && (activeSegment !== 'by_city' || selectedCityId)) {
      loadSegmentUsers(activeSegment, page, selectedCityId);
    }
  }, [page]);

  const handleCityChange = (cityId: string) => {
    setSelectedCityId(cityId);
    if (activeSegment === 'by_city' && cityId) {
      setPage(0);
      loadSegmentUsers('by_city', 0, cityId);
      // Update city count
      const supabase = getSupabaseClient();
      supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('city_id', cityId)
        .then(({ count }) => {
          setCounts((prev) => ({ ...prev, by_city: count ?? 0 }));
        });
    }
  };

  const handleExportCSV = () => {
    if (users.length === 0) return;
    const headers = [
      t('segments.col_name'),
      t('segments.col_email'),
      t('segments.col_phone'),
      t('segments.col_rides'),
      t('segments.col_last_ride'),
      t('segments.col_city'),
    ];
    const rows = users.map((u) => [
      u.full_name ?? '',
      u.email ?? '',
      u.phone ?? '',
      String(u.rides_count),
      u.last_ride_date ? new Date(u.last_ride_date).toISOString().split('T')[0] : '',
      u.city_name ?? '',
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.map((v) => `"${v}"`).join(','))].join(
      '\n',
    );
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `segment_${activeSegment}_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const segments: { type: SegmentType; labelKey: string; color: string }[] = [
    { type: 'new_users', labelKey: 'segments.new_users', color: 'bg-green-50 border-green-200' },
    {
      type: 'power_users',
      labelKey: 'segments.power_users',
      color: 'bg-purple-50 border-purple-200',
    },
    { type: 'inactive', labelKey: 'segments.inactive', color: 'bg-orange-50 border-orange-200' },
    { type: 'by_city', labelKey: 'segments.by_city', color: 'bg-blue-50 border-blue-200' },
  ];

  const canGoPrev = page > 0;
  const canGoNext = users.length === PAGE_SIZE;

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-6">{t('segments.title')}</h1>

      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); }}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Segment cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {segments.map((seg) => (
          <div
            key={seg.type}
            className={`rounded-xl border p-5 ${seg.color} ${
              activeSegment === seg.type ? 'ring-2 ring-primary-500' : ''
            }`}
          >
            <h3 className="text-sm font-semibold text-neutral-700 mb-1">{t(seg.labelKey)}</h3>
            <p className="text-3xl font-bold text-neutral-900 mb-3">
              {countsLoading ? '...' : counts[seg.type]}
            </p>

            {seg.type === 'by_city' && (
              <div className="mb-3">
                <select
                  value={selectedCityId}
                  onChange={(e) => handleCityChange(e.target.value)}
                  className="w-full border border-neutral-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-primary-500 bg-white"
                >
                  <option value="">{t('segments.select_city')}</option>
                  {cities.map((city) => (
                    <option key={city.id} value={city.id}>
                      {city.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => handleViewUsers(seg.type)}
                disabled={seg.type === 'by_city' && !selectedCityId}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white text-neutral-700 border border-neutral-200 hover:border-neutral-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('segments.view_users')}
              </button>
              {activeSegment === seg.type && users.length > 0 && (
                <button
                  onClick={handleExportCSV}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors"
                >
                  {t('segments.export_csv')}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Users table */}
      {activeSegment && (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-neutral-100 flex items-center justify-between">
            <h2 className="text-lg font-bold">
              {t(`segments.${activeSegment}`)} ({users.length > 0 ? `${t('common.page')} ${page + 1}` : '0'})
            </h2>
            {users.length > 0 && (
              <button
                onClick={handleExportCSV}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors"
              >
                {t('segments.export_csv')}
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-neutral-100">
                  <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                    {t('segments.col_name')}
                  </th>
                  <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap hidden lg:table-cell">
                    {t('segments.col_email')}
                  </th>
                  <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                    {t('segments.col_phone')}
                  </th>
                  <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap">
                    {t('segments.col_rides')}
                  </th>
                  <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap hidden lg:table-cell">
                    {t('segments.col_last_ride')}
                  </th>
                  <th className="text-left px-6 py-4 text-sm font-semibold text-neutral-500 whitespace-nowrap hidden lg:table-cell">
                    {t('segments.col_city')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {usersLoading ? (
                  <tr>
                    <td colSpan={6} className="px-0 py-0">
                      <AdminTableSkeleton rows={5} columns={6} />
                    </td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={6}><AdminEmptyState icon="👥" title={t('segments.no_users')} /></td>
                  </tr>
                ) : (
                  users.map((user) => (
                    <tr
                      key={user.id}
                      className="border-b border-neutral-50 hover:bg-neutral-50/50 transition-colors"
                    >
                      <td className="px-6 py-4 text-sm text-neutral-900 font-medium">
                        {user.full_name ?? t('common.no_name')}
                      </td>
                      <td className="px-6 py-4 text-sm text-neutral-600 hidden lg:table-cell">
                        {user.email ?? '\u2014'}
                      </td>
                      <td className="px-6 py-4 text-sm text-neutral-600">{user.phone ?? '\u2014'}</td>
                      <td className="px-6 py-4 text-sm text-neutral-600">{user.rides_count}</td>
                      <td className="px-6 py-4 text-sm text-neutral-600 hidden lg:table-cell">
                        {formatAdminDate(user.last_ride_date)}
                      </td>
                      <td className="px-6 py-4 text-sm text-neutral-600 hidden lg:table-cell">
                        {user.city_name ?? '\u2014'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {(canGoPrev || canGoNext) && (
            <div className="flex items-center justify-between px-6 py-4 border-t border-neutral-100">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={!canGoPrev}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  canGoPrev
                    ? 'bg-neutral-100 hover:bg-neutral-200 text-neutral-700'
                    : 'bg-neutral-50 text-neutral-300 cursor-not-allowed'
                }`}
              >
                {t('common.previous')}
              </button>
              <span className="text-sm text-neutral-500">
                {t('common.page')} {page + 1}
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={!canGoNext}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  canGoNext
                    ? 'bg-neutral-100 hover:bg-neutral-200 text-neutral-700'
                    : 'bg-neutral-50 text-neutral-300 cursor-not-allowed'
                }`}
              >
                {t('common.next')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
