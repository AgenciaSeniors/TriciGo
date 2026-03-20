'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { Ride, DriverProfileWithUser, AdminAction } from '@tricigo/types';

type DashboardMetrics = {
  active_rides: number;
  total_rides_today: number;
  online_drivers: number;
  total_revenue_today: number;
  pending_verifications: number;
  open_incidents: number;
};

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
  searching: 'dashboard.status_searching',
  accepted: 'dashboard.status_accepted',
  driver_en_route: 'dashboard.status_driver_en_route',
  arrived_at_pickup: 'dashboard.status_arrived_at_pickup',
  in_progress: 'dashboard.status_in_progress',
  completed: 'dashboard.status_completed',
  canceled: 'dashboard.status_canceled',
  disputed: 'dashboard.status_disputed',
};

function truncate(str: string, len: number) {
  return str.length > len ? str.slice(0, len) + '…' : str;
}

export default function DashboardPage() {
  const { t } = useTranslation('admin');
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [recentRides, setRecentRides] = useState<Ride[]>([]);
  const [pendingDrivers, setPendingDrivers] = useState<DriverProfileWithUser[]>([]);
  const [autoActions, setAutoActions] = useState<AdminAction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchDashboard() {
      try {
        const [metricsData, rides, drivers, autoActionsData] = await Promise.all([
          adminService.getDashboardMetrics(),
          adminService.getRides({}, 0, 5),
          adminService.getDriversByStatus('pending_verification', 0, 5),
          adminService.getRecentAutoActions(5).catch(() => [] as AdminAction[]),
        ]);
        if (!cancelled) {
          setMetrics(metricsData);
          setRecentRides(rides);
          setPendingDrivers(drivers);
          setAutoActions(autoActionsData);
        }
      } catch (err) {
        console.error('Error fetching dashboard:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDashboard();

    const interval = setInterval(fetchDashboard, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const stats = [
    { label: t('dashboard.active_rides'), value: metrics?.active_rides ?? 0, color: 'text-primary-500', format: 'number' as const },
    { label: t('dashboard.total_rides_today'), value: metrics?.total_rides_today ?? 0, color: 'text-neutral-900', format: 'number' as const },
    { label: t('dashboard.online_drivers'), value: metrics?.online_drivers ?? 0, color: 'text-green-600', format: 'number' as const },
    { label: t('dashboard.revenue_today'), value: metrics?.total_revenue_today ?? 0, color: 'text-primary-500', format: 'cup' as const },
    { label: t('dashboard.pending_verifications'), value: metrics?.pending_verifications ?? 0, color: 'text-yellow-600', format: 'number' as const },
    { label: t('dashboard.open_incidents'), value: metrics?.open_incidents ?? 0, color: 'text-red-600', format: 'number' as const },
  ];

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">{t('dashboard.title')}</h1>

      {/* Metric cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100"
          >
            {loading ? (
              <>
                <div className="h-4 w-24 bg-neutral-200 rounded animate-pulse mb-3" />
                <div className="h-8 w-20 bg-neutral-200 rounded animate-pulse" />
              </>
            ) : (
              <>
                <p className="text-sm text-neutral-500 mb-1">{stat.label}</p>
                <p className={`text-3xl font-bold ${stat.color}`}>
                  {stat.format === 'cup' ? formatCUP(stat.value) : stat.value}
                </p>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Bottom section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent rides */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
          <h2 className="text-lg font-bold mb-4">{t('dashboard.recent_rides')}</h2>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-neutral-50 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="h-4 w-48 bg-neutral-200 rounded animate-pulse mb-1" />
                    <div className="h-3 w-36 bg-neutral-200 rounded animate-pulse" />
                  </div>
                  <div className="ml-3 h-5 w-16 bg-neutral-200 rounded-full animate-pulse" />
                </div>
              ))}
            </div>
          ) : recentRides.length === 0 ? (
            <p className="text-neutral-400">{t('dashboard.no_recent_rides')}</p>
          ) : (
            <div className="space-y-3">
              {recentRides.map((ride) => (
                <div key={ride.id} className="flex items-center justify-between py-2 border-b border-neutral-50 last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-neutral-900 truncate">{truncate(ride.pickup_address, 30)}</p>
                    <p className="text-xs text-neutral-500">→ {truncate(ride.dropoff_address, 30)}</p>
                  </div>
                  <span className={`ml-3 inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[ride.status] ?? 'bg-neutral-100 text-neutral-700'}`}>
                    {STATUS_LABEL_KEY[ride.status] ? t(STATUS_LABEL_KEY[ride.status]!) : ride.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pending drivers */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
          <h2 className="text-lg font-bold mb-4">{t('dashboard.pending_drivers')}</h2>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-neutral-50 last:border-0">
                  <div>
                    <div className="h-4 w-32 bg-neutral-200 rounded animate-pulse mb-1" />
                    <div className="h-3 w-24 bg-neutral-200 rounded animate-pulse" />
                  </div>
                  <div className="h-4 w-14 bg-neutral-200 rounded animate-pulse" />
                </div>
              ))}
            </div>
          ) : pendingDrivers.length === 0 ? (
            <p className="text-neutral-400">{t('dashboard.no_pending_drivers')}</p>
          ) : (
            <div className="space-y-3">
              {pendingDrivers.map((driver) => (
                <div key={driver.id} className="flex items-center justify-between py-2 border-b border-neutral-50 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-neutral-900">
                      {(driver as unknown as { users: { full_name: string } }).users?.full_name ?? t('common.no_name')}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {(driver as unknown as { users: { phone: string } }).users?.phone ?? ''}
                    </p>
                  </div>
                  <a
                    href={`/drivers/${driver.id}`}
                    className="text-sm text-primary-500 hover:underline"
                  >
                    {t('common.view_detail')}
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Automated actions */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
          <h2 className="text-lg font-bold mb-4">{t('dashboard_auto.recent_auto_actions')}</h2>
          {autoActions.length === 0 ? (
            <p className="text-neutral-400">{t('dashboard_auto.no_auto_actions')}</p>
          ) : (
            <div className="space-y-3">
              {autoActions.map((action) => {
                const labelKey = `dashboard_auto.${action.action}`;
                const label = t(labelKey) !== labelKey ? t(labelKey) : action.action.replace(/_/g, ' ');
                const timeAgo = action.created_at
                  ? new Date(action.created_at).toLocaleTimeString()
                  : '';
                return (
                  <div key={action.id} className="flex items-center justify-between py-2 border-b border-neutral-50 last:border-0">
                    <div>
                      <p className="text-sm text-neutral-900">{label}</p>
                      <p className="text-xs text-neutral-400 font-mono">
                        {action.target_id?.slice(0, 8)}...
                      </p>
                    </div>
                    <span className="text-xs text-neutral-400">{timeAgo}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
