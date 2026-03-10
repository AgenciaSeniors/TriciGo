'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP, formatTriciCoin } from '@tricigo/utils';

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
      label: 'Viajes activos',
      value: loading ? '—' : String(metrics?.active_rides ?? 0),
      color: 'text-[#FF4D00]',
      description: 'Viajes en curso en este momento',
    },
    {
      label: 'Viajes hoy',
      value: loading ? '—' : String(metrics?.total_rides_today ?? 0),
      color: 'text-neutral-900',
      description: 'Total de viajes creados hoy',
    },
    {
      label: 'Conductores en línea',
      value: loading ? '—' : String(metrics?.online_drivers ?? 0),
      color: 'text-green-600',
      description: 'Conductores actualmente disponibles',
    },
    {
      label: 'Ingresos hoy',
      value: loading ? '—' : formatCUP(metrics?.total_revenue_today ?? 0),
      color: 'text-[#FF4D00]',
      description: 'Ingresos generados hoy en CUP',
    },
    {
      label: 'Verificaciones pendientes',
      value: loading ? '—' : String(metrics?.pending_verifications ?? 0),
      color: 'text-yellow-600',
      description: 'Conductores esperando verificación',
    },
    {
      label: 'Incidentes abiertos',
      value: loading ? '—' : String(metrics?.open_incidents ?? 0),
      color: 'text-red-600',
      description: 'Incidentes sin resolver',
    },
  ];

  const walletCards: {
    label: string;
    value: string;
    color: string;
    description: string;
  }[] = [
    {
      label: 'TC en circulación',
      value: loading
        ? '—'
        : formatTriciCoin(walletStats?.total_in_circulation ?? 0),
      color: 'text-[#FF4D00]',
      description: 'Total de TriciCoin en el sistema',
    },
    {
      label: 'Canjes pendientes',
      value: loading
        ? '—'
        : String(walletStats?.pending_redemptions_count ?? 0),
      color: 'text-yellow-600',
      description: 'Canjes esperando aprobación',
    },
    {
      label: 'Monto pendiente',
      value: loading
        ? '—'
        : formatTriciCoin(walletStats?.pending_redemptions_amount ?? 0),
      color: 'text-neutral-900',
      description: 'Monto total de canjes pendientes',
    },
  ];

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Reportes</h1>

      {/* Operations section */}
      <section className="mb-8">
        <h2 className="text-lg font-bold text-neutral-800 mb-4">
          Operaciones
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
          Finanzas / Wallet
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
          Los datos se obtienen en tiempo real del servidor. Las métricas de
          ingresos son del día actual. Para información histórica detallada,
          consulte la sección de{' '}
          <a
            href="/wallet"
            className="text-[#FF4D00] hover:underline font-medium"
          >
            Wallet / Finanzas
          </a>{' '}
          o la{' '}
          <a
            href="/audit"
            className="text-[#FF4D00] hover:underline font-medium"
          >
            Auditoría
          </a>
          .
        </p>
      </div>
    </div>
  );
}
