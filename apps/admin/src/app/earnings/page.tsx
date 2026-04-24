'use client';

// ============================================================
// Admin · Earnings dashboard
// ============================================================
//
// Surfaces the platform's take from ride commissions — previously the
// `get_platform_earnings` RPC existed (migration 00149) but no UI page
// consumed it, so admins had no way to see how much commission the
// platform had collected. This page fills that gap:
//
//   * Platform revenue balance (all-time commission held)
//   * Today / this-week / this-month earnings
//   * Current commission rate (live from platform_config)
//   * Top-earning drivers (reusing `get_top_drivers`)
//
// All queries are SECURITY DEFINER-backed RPCs that gate on is_admin().

import { useEffect, useState } from 'react';
import { DollarSign, TrendingUp, Users, Wallet } from 'lucide-react';
import { adminService } from '@tricigo/api/services/admin';
import { formatTriciCoin } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { DataTable, type DataColumn } from '@/components/data/DataTable';

type PlatformEarnings = Awaited<ReturnType<typeof adminService.getPlatformEarnings>>;
type TopDriver = {
  driver_id: string;
  driver_name: string | null;
  rides_count: number;
  rating: number | null;
  revenue: number;
};

export default function EarningsPage() {
  const { t } = useTranslation('admin');
  const [earnings, setEarnings] = useState<PlatformEarnings | null>(null);
  const [topDrivers, setTopDrivers] = useState<TopDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [earningsData, driversData] = await Promise.all([
        adminService.getPlatformEarnings(),
        adminService.getTopDrivers(10).catch(() => [] as TopDriver[]),
      ]);
      setEarnings(earningsData);
      setTopDrivers(driversData as TopDriver[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchAll();
  }, []);

  const commissionPct = earnings ? Math.round(earnings.commission_rate * 100) : null;

  const topDriverColumns: DataColumn<TopDriver>[] = [
    {
      id: 'driver_name',
      header: t('earnings.col_driver', { defaultValue: 'Conductor' }),
      cell: (r) => <span className="font-medium text-ink">{r.driver_name || '—'}</span>,
      primary: true,
    },
    {
      id: 'rides_count',
      header: t('earnings.col_rides', { defaultValue: 'Viajes' }),
      cell: (r) => <span className="text-ink">{r.rides_count}</span>,
      align: 'right',
      mono: true,
      width: '110px',
    },
    {
      id: 'rating',
      header: t('earnings.col_rating', { defaultValue: 'Rating' }),
      cell: (r) => (
        <span className="text-ink">
          {r.rating != null ? `★ ${r.rating.toFixed(1)}` : '—'}
        </span>
      ),
      align: 'right',
      mono: true,
      width: '100px',
      hideBelow: 'md',
    },
    {
      id: 'revenue',
      header: t('earnings.col_revenue', { defaultValue: 'Facturación' }),
      cell: (r) => (
        <span className="font-medium text-ink">
          {formatTriciCoin(r.revenue)}
        </span>
      ),
      align: 'right',
      mono: true,
      width: '160px',
      secondary: true,
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('earnings.page_eyebrow', { defaultValue: 'Finanzas · comisiones' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('earnings.title', { defaultValue: 'Ingresos de la plataforma' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('earnings.description', {
              defaultValue:
                'Comisiones cobradas en todos los viajes completados. Todo el cálculo viene del RPC get_platform_earnings.',
            })}
          </p>
        </div>
        {commissionPct != null && (
          <div className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] text-ink">
            {t('earnings.commission_rate', {
              defaultValue: 'Comisión actual: {{pct}}%',
              pct: commissionPct,
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label={t('earnings.kpi_balance', { defaultValue: 'Saldo plataforma' })}
          value={earnings ? formatTriciCoin(earnings.platform_balance).replace('TRC', '').trim() : '—'}
          unit="TRC"
          tone="primary"
          loading={loading}
          icon={Wallet}
        />
        <KpiCard
          label={t('earnings.kpi_today', { defaultValue: 'Hoy' })}
          value={earnings ? formatTriciCoin(earnings.earnings_today).replace('TRC', '').trim() : '—'}
          unit="TRC"
          loading={loading}
          icon={DollarSign}
        />
        <KpiCard
          label={t('earnings.kpi_week', { defaultValue: 'Esta semana' })}
          value={earnings ? formatTriciCoin(earnings.earnings_this_week).replace('TRC', '').trim() : '—'}
          unit="TRC"
          loading={loading}
          icon={TrendingUp}
        />
        <KpiCard
          label={t('earnings.kpi_month', { defaultValue: 'Este mes' })}
          value={earnings ? formatTriciCoin(earnings.earnings_this_month).replace('TRC', '').trim() : '—'}
          unit="TRC"
          tone={earnings && earnings.earnings_this_month > 0 ? 'success' : 'default'}
          loading={loading}
          icon={TrendingUp}
        />
      </div>

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-[12.5px] text-danger">
          {error}
        </div>
      )}

      <div>
        <h2 className="mb-2 font-display text-[18px] font-semibold tracking-[-0.01em] text-ink">
          {t('earnings.top_drivers_title', { defaultValue: 'Conductores con más facturación' })}
        </h2>
        <p className="mb-3 text-[12px] text-ink-muted">
          {t('earnings.top_drivers_desc', {
            defaultValue:
              'Top 10 por ingresos brutos (suma de final_fare). La comisión de la plataforma se descuenta antes de lo que cobran los conductores.',
          })}
        </p>
        <DataTable<TopDriver>
          columns={topDriverColumns}
          rows={topDrivers}
          keyField="driver_id"
          loading={loading}
          error={error}
          onRetry={() => void fetchAll()}
          empty={{
            icon: Users,
            tone: 'default',
            title: t('earnings.empty_top_title', { defaultValue: 'Sin datos de conductores' }),
            body: t('earnings.empty_top_body', {
              defaultValue: 'Aún no hay viajes completados suficientes para construir el ranking.',
            }),
          }}
        />
      </div>
    </div>
  );
}
