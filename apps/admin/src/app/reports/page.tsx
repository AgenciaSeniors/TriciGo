'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP, formatTriciCoin } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';

type DashboardMetrics = {
  active_rides: number;
  total_rides_today: number;
  online_drivers: number;
  total_revenue_today: number;
  pending_verifications: number;
  open_incidents: number;
};

type WalletStats = {
  total_in_circulation: number;
  pending_redemptions_count: number;
  pending_redemptions_amount: number;
};

export default function ReportsPage() {
  const { t } = useTranslation('admin');
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [walletStats, setWalletStats] = useState<WalletStats | null>(null);
  const [totalRides, setTotalRides] = useState<number | null>(null);
  const [totalUsers, setTotalUsers] = useState<number | null>(null);
  const [totalDrivers, setTotalDrivers] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchReports() {
      try {
        const [metricsData, walletData, ridesData, usersData, driversData] =
          await Promise.all([
            adminService.getDashboardMetrics(),
            adminService.getWalletStats(),
            adminService.getRides({}, 0, 1),
            adminService.getUsers(0, 1),
            adminService.getAllDrivers(0, 1),
          ]);
        if (!cancelled) {
          setMetrics(metricsData);
          setWalletStats(walletData);
          // Use the presence of data to estimate counts
          // The actual count comes from the dashboard metrics RPC
          setTotalRides(ridesData.length > 0 ? metricsData.total_rides_today : 0);
          setTotalUsers(usersData.length);
          setTotalDrivers(driversData.length);
        }
      } catch (err) {
        console.error('Error fetching reports:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchReports();
    return () => {
      cancelled = true;
    };
  }, []);

  const cards: {
    label: string;
    value: string;
    color: string;
    description: string;
  }[] = [
    {
      label: t('reports.active_rides'),
      value: loading ? '—' : String(metrics?.active_rides ?? 0),
      color: 'text-primary-500',
      description: t('reports.desc_active_rides'),
    },
    {
      label: t('reports.rides_today'),
      value: loading ? '—' : String(metrics?.total_rides_today ?? 0),
      color: 'text-neutral-900',
      description: t('reports.desc_rides_today'),
    },
    {
      label: t('reports.online_drivers'),
      value: loading ? '—' : String(metrics?.online_drivers ?? 0),
      color: 'text-green-600',
      description: t('reports.desc_online_drivers'),
    },
    {
      label: t('reports.revenue_today'),
      value: loading ? '—' : formatCUP(metrics?.total_revenue_today ?? 0),
      color: 'text-primary-500',
      description: t('reports.desc_revenue_today'),
    },
    {
      label: t('reports.pending_verifications'),
      value: loading ? '—' : String(metrics?.pending_verifications ?? 0),
      color: 'text-yellow-600',
      description: t('reports.desc_pending_verifications'),
    },
    {
      label: t('reports.open_incidents'),
      value: loading ? '—' : String(metrics?.open_incidents ?? 0),
      color: 'text-red-600',
      description: t('reports.desc_open_incidents'),
    },
  ];

  const walletCards: {
    label: string;
    value: string;
    color: string;
    description: string;
  }[] = [
    {
      label: t('reports.circulation'),
      value: loading
        ? '—'
        : formatTriciCoin(walletStats?.total_in_circulation ?? 0),
      color: 'text-primary-500',
      description: t('reports.desc_circulation'),
    },
    {
      label: t('reports.pending_redemptions'),
      value: loading
        ? '—'
        : String(walletStats?.pending_redemptions_count ?? 0),
      color: 'text-yellow-600',
      description: t('reports.desc_pending_redemptions'),
    },
    {
      label: t('reports.pending_amount'),
      value: loading
        ? '—'
        : formatTriciCoin(walletStats?.pending_redemptions_amount ?? 0),
      color: 'text-neutral-900',
      description: t('reports.desc_pending_amount'),
    },
  ];

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-6">{t('reports.title')}</h1>

      {/* Operations section */}
      <section className="mb-8">
        <h2 className="text-lg font-bold text-neutral-800 mb-4">
          {t('reports.section_operations')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {cards.map((card) => (
            <div
              key={card.label}
              className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100"
            >
              <p className="text-sm text-neutral-500 mb-1">{card.label}</p>
              <p className={`text-3xl font-bold ${card.color}`}>
                {card.value}
              </p>
              <p className="text-xs text-neutral-400 mt-2">
                {card.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Wallet / finance section */}
      <section className="mb-8">
        <h2 className="text-lg font-bold text-neutral-800 mb-4">
          {t('reports.section_finance')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {walletCards.map((card) => (
            <div
              key={card.label}
              className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100"
            >
              <p className="text-sm text-neutral-500 mb-1">{card.label}</p>
              <p className={`text-2xl font-bold ${card.color}`}>
                {card.value}
              </p>
              <p className="text-xs text-neutral-400 mt-2">
                {card.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Informational note */}
      <div className="bg-neutral-50 rounded-xl p-6 border border-neutral-100">
        <p className="text-sm text-neutral-500">
          {t('reports.note')}
        </p>
      </div>
    </div>
  );
}
