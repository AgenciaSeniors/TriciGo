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

type DayData = { day: string; total: number; completed: number; canceled: number; revenue: number };
type ServiceData = { service_type: string; count: number; revenue: number };
type PaymentData = { payment_method: string; count: number; revenue: number };
type HourData = { hour: number; avg_rides: number };
type DriverData = { driver_id: string; driver_name: string; rides_count: number; rating: number; revenue: number };
type UtilData = { online: number; busy: number; idle: number; offline: number };

const PERIOD_OPTIONS = [
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
];

const BAR_COLORS = ['bg-primary-500', 'bg-green-500', 'bg-amber-500', 'bg-blue-500', 'bg-red-400'];
const UTIL_COLORS: Record<string, string> = {
  busy: 'bg-primary-500',
  idle: 'bg-amber-400',
  offline: 'bg-neutral-300',
};

export default function ReportsPage() {
  const { t } = useTranslation('admin');
  const [period, setPeriod] = useState(30);
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [walletStats, setWalletStats] = useState<WalletStats | null>(null);
  const [ridesByDay, setRidesByDay] = useState<DayData[]>([]);
  const [ridesByService, setRidesByService] = useState<ServiceData[]>([]);
  const [ridesByPayment, setRidesByPayment] = useState<PaymentData[]>([]);
  const [peakHours, setPeakHours] = useState<HourData[]>([]);
  const [topDrivers, setTopDrivers] = useState<DriverData[]>([]);
  const [utilization, setUtilization] = useState<UtilData | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function fetchAll() {
      try {
        const [metricsD, walletD, byDay, byService, byPayment, hours, drivers, util] =
          await Promise.all([
            adminService.getDashboardMetrics(),
            adminService.getWalletStats(),
            adminService.getRidesByDay(period),
            adminService.getRidesByServiceType(period),
            adminService.getRidesByPaymentMethod(period),
            adminService.getPeakHours(period),
            adminService.getTopDrivers(10),
            adminService.getDriverUtilization(),
          ]);
        if (!cancelled) {
          setMetrics(metricsD);
          setWalletStats(walletD);
          setRidesByDay(byDay);
          setRidesByService(byService);
          setRidesByPayment(byPayment);
          setPeakHours(hours);
          setTopDrivers(drivers);
          setUtilization(util);
        }
      } catch (err) {
        console.error('Error fetching reports:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAll();
    return () => { cancelled = true; };
  }, [period]);

  // KPI cards
  const kpiCards = [
    { label: t('reports.active_rides'), value: metrics?.active_rides ?? 0, color: 'text-primary-500', desc: t('reports.desc_active_rides') },
    { label: t('reports.rides_today'), value: metrics?.total_rides_today ?? 0, color: 'text-neutral-900', desc: t('reports.desc_rides_today') },
    { label: t('reports.online_drivers'), value: metrics?.online_drivers ?? 0, color: 'text-green-600', desc: t('reports.desc_online_drivers') },
    { label: t('reports.revenue_today'), value: formatCUP(metrics?.total_revenue_today ?? 0), color: 'text-primary-500', desc: t('reports.desc_revenue_today'), isFormatted: true },
    { label: t('reports.pending_verifications'), value: metrics?.pending_verifications ?? 0, color: 'text-yellow-600', desc: t('reports.desc_pending_verifications') },
    { label: t('reports.open_incidents'), value: metrics?.open_incidents ?? 0, color: 'text-red-600', desc: t('reports.desc_open_incidents') },
  ];

  // Revenue trend helpers
  const maxRevenue = Math.max(...ridesByDay.map((d) => d.revenue), 1);
  const maxRides = Math.max(...ridesByDay.map((d) => d.total), 1);

  // Peak hours helpers
  const maxAvgRides = Math.max(...peakHours.map((h) => h.avg_rides), 1);

  // Service type total
  const serviceTotal = ridesByService.reduce((s, r) => s + r.count, 0) || 1;

  // Payment total
  const paymentTotal = ridesByPayment.reduce((s, r) => s + r.count, 0) || 1;

  // Utilization total
  const utilTotal = utilization ? utilization.busy + utilization.idle + utilization.offline : 1;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">{t('reports.title')}</h1>

        {/* Period selector */}
        <div className="flex gap-1 bg-neutral-100 rounded-lg p-1">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setPeriod(opt.value)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                period === opt.value
                  ? 'bg-white text-neutral-900 shadow-sm'
                  : 'text-neutral-500 hover:text-neutral-700'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="text-center py-12 text-neutral-400">{t('common.loading')}</div>
      )}

      {!loading && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
            {kpiCards.map((card) => (
              <div key={card.label} className="bg-white rounded-xl p-4 shadow-sm border border-neutral-100">
                <p className="text-xs text-neutral-500 mb-1">{card.label}</p>
                <p className={`text-2xl font-bold ${card.color}`}>
                  {card.isFormatted ? card.value : String(card.value)}
                </p>
              </div>
            ))}
          </div>

          {/* Revenue Trend */}
          <section className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 mb-6">
            <h2 className="text-lg font-bold text-neutral-800 mb-4">{t('reports.revenue_trend')}</h2>
            <div className="flex items-end gap-[2px] h-40">
              {ridesByDay.map((d, i) => (
                <div
                  key={d.day}
                  className="flex-1 group relative"
                  title={`${d.day}: ${formatCUP(d.revenue)} (${d.total} ${t('reports.rides_label')})`}
                >
                  <div
                    className="w-full bg-primary-500/80 rounded-t-sm transition-all hover:bg-primary-600"
                    style={{ height: `${Math.max((d.revenue / maxRevenue) * 100, 2)}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-between mt-2 text-xs text-neutral-400">
              <span>{ridesByDay[0]?.day ? new Date(ridesByDay[0].day).toLocaleDateString('es-CU', { month: 'short', day: 'numeric' }) : ''}</span>
              <span>{ridesByDay[ridesByDay.length - 1]?.day ? new Date(ridesByDay[ridesByDay.length - 1]!.day).toLocaleDateString('es-CU', { month: 'short', day: 'numeric' }) : ''}</span>
            </div>
          </section>

          {/* Two-column grid: Service Type + Payment Method */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* Rides by Service Type */}
            <section className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
              <h2 className="text-lg font-bold text-neutral-800 mb-4">{t('reports.rides_by_service')}</h2>
              <div className="space-y-3">
                {ridesByService.map((s, i) => {
                  const pct = Math.round((s.count / serviceTotal) * 100);
                  return (
                    <div key={s.service_type}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-neutral-700 font-medium">{s.service_type}</span>
                        <span className="text-neutral-500">{s.count} ({pct}%)</span>
                      </div>
                      <div className="w-full bg-neutral-100 rounded-full h-2.5">
                        <div
                          className={`h-2.5 rounded-full ${BAR_COLORS[i % BAR_COLORS.length]}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
                {ridesByService.length === 0 && (
                  <p className="text-sm text-neutral-400">{t('reports.no_data')}</p>
                )}
              </div>
            </section>

            {/* Rides by Payment Method */}
            <section className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
              <h2 className="text-lg font-bold text-neutral-800 mb-4">{t('reports.rides_by_payment')}</h2>
              <div className="space-y-3">
                {ridesByPayment.map((p, i) => {
                  const pct = Math.round((p.count / paymentTotal) * 100);
                  const label = p.payment_method === 'cash'
                    ? t('rides.payment_cash')
                    : p.payment_method === 'tricicoin'
                      ? t('rides.payment_tricicoin')
                      : p.payment_method;
                  return (
                    <div key={p.payment_method}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-neutral-700 font-medium">{label}</span>
                        <span className="text-neutral-500">{p.count} ({pct}%) — {formatCUP(p.revenue)}</span>
                      </div>
                      <div className="w-full bg-neutral-100 rounded-full h-2.5">
                        <div
                          className={`h-2.5 rounded-full ${BAR_COLORS[i % BAR_COLORS.length]}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
                {ridesByPayment.length === 0 && (
                  <p className="text-sm text-neutral-400">{t('reports.no_data')}</p>
                )}
              </div>
            </section>
          </div>

          {/* Peak Hours */}
          <section className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 mb-6">
            <h2 className="text-lg font-bold text-neutral-800 mb-4">{t('reports.peak_hours')}</h2>
            <div className="flex items-end gap-1 h-32">
              {Array.from({ length: 24 }, (_, h) => {
                const data = peakHours.find((p) => p.hour === h);
                const avg = data?.avg_rides ?? 0;
                const pct = Math.max((avg / maxAvgRides) * 100, 2);
                const isHigh = avg >= maxAvgRides * 0.7;
                return (
                  <div
                    key={h}
                    className="flex-1 group relative"
                    title={`${h}:00 — ${avg} ${t('reports.avg_rides_label')}`}
                  >
                    <div
                      className={`w-full rounded-t-sm transition-all ${isHigh ? 'bg-red-400 hover:bg-red-500' : 'bg-primary-400/70 hover:bg-primary-500'}`}
                      style={{ height: `${pct}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between mt-2 text-xs text-neutral-400">
              <span>0h</span>
              <span>6h</span>
              <span>12h</span>
              <span>18h</span>
              <span>23h</span>
            </div>
          </section>

          {/* Two-column: Top Drivers + Driver Utilization */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
            {/* Top Drivers */}
            <section className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 lg:col-span-2">
              <h2 className="text-lg font-bold text-neutral-800 mb-4">{t('reports.top_drivers')}</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-100">
                      <th className="text-left py-2 text-neutral-500 font-medium">#</th>
                      <th className="text-left py-2 text-neutral-500 font-medium">{t('drivers.col_name')}</th>
                      <th className="text-right py-2 text-neutral-500 font-medium">{t('reports.rides_label')}</th>
                      <th className="text-right py-2 text-neutral-500 font-medium">{t('drivers.col_rating')}</th>
                      <th className="text-right py-2 text-neutral-500 font-medium">{t('reports.revenue_label')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topDrivers.map((d, i) => (
                      <tr key={d.driver_id} className="border-b border-neutral-50">
                        <td className="py-2 text-neutral-400">{i + 1}</td>
                        <td className="py-2 text-neutral-900 font-medium">{d.driver_name}</td>
                        <td className="py-2 text-right text-neutral-600">{d.rides_count}</td>
                        <td className="py-2 text-right text-neutral-600">{Number(d.rating).toFixed(1)}</td>
                        <td className="py-2 text-right text-neutral-600">{formatCUP(d.revenue)}</td>
                      </tr>
                    ))}
                    {topDrivers.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-neutral-400">{t('reports.no_data')}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Driver Utilization */}
            <section className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
              <h2 className="text-lg font-bold text-neutral-800 mb-4">{t('reports.driver_utilization')}</h2>
              {utilization && (
                <div className="space-y-4">
                  {/* Stacked bar */}
                  <div className="flex rounded-full h-6 overflow-hidden">
                    {utilization.busy > 0 && (
                      <div
                        className={`${UTIL_COLORS.busy}`}
                        style={{ width: `${(utilization.busy / utilTotal) * 100}%` }}
                        title={`${t('reports.util_busy')}: ${utilization.busy}`}
                      />
                    )}
                    {utilization.idle > 0 && (
                      <div
                        className={`${UTIL_COLORS.idle}`}
                        style={{ width: `${(utilization.idle / utilTotal) * 100}%` }}
                        title={`${t('reports.util_idle')}: ${utilization.idle}`}
                      />
                    )}
                    {utilization.offline > 0 && (
                      <div
                        className={`${UTIL_COLORS.offline}`}
                        style={{ width: `${(utilization.offline / utilTotal) * 100}%` }}
                        title={`${t('reports.util_offline')}: ${utilization.offline}`}
                      />
                    )}
                  </div>

                  {/* Legend */}
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full bg-primary-500" />
                        <span className="text-neutral-600">{t('reports.util_busy')}</span>
                      </div>
                      <span className="font-medium">{utilization.busy}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full bg-amber-400" />
                        <span className="text-neutral-600">{t('reports.util_idle')}</span>
                      </div>
                      <span className="font-medium">{utilization.idle}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full bg-neutral-300" />
                        <span className="text-neutral-600">{t('reports.util_offline')}</span>
                      </div>
                      <span className="font-medium">{utilization.offline}</span>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-neutral-100">
                    <p className="text-xs text-neutral-400">
                      {t('reports.total_online')}: <strong>{utilization.online}</strong>
                    </p>
                  </div>
                </div>
              )}
            </section>
          </div>

          {/* Wallet section */}
          <section className="mb-6">
            <h2 className="text-lg font-bold text-neutral-800 mb-4">{t('reports.section_finance')}</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
                <p className="text-sm text-neutral-500 mb-1">{t('reports.circulation')}</p>
                <p className="text-2xl font-bold text-primary-500">{formatTriciCoin(walletStats?.total_in_circulation ?? 0)}</p>
              </div>
              <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
                <p className="text-sm text-neutral-500 mb-1">{t('reports.pending_redemptions')}</p>
                <p className="text-2xl font-bold text-yellow-600">{walletStats?.pending_redemptions_count ?? 0}</p>
              </div>
              <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
                <p className="text-sm text-neutral-500 mb-1">{t('reports.pending_amount')}</p>
                <p className="text-2xl font-bold text-neutral-900">{formatTriciCoin(walletStats?.pending_redemptions_amount ?? 0)}</p>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
