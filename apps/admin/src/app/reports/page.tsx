'use client';

import { useEffect, useState, useCallback } from 'react';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP, formatTriciCoin } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { createBrowserClient } from '@/lib/supabase-server';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { AdminEmptyState } from '@/components/ui/AdminEmptyState';
import { Download } from 'lucide-react';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { SectionCard } from '@/components/dashboard/SectionCard';

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
type ForecastDay = { day: string; revenue: number; predicted: boolean };

function linearRegression(data: { x: number; y: number }[]) {
  const n = data.length;
  if (n < 2) return { slope: 0, intercept: 0 };
  const sumX = data.reduce((s, d) => s + d.x, 0);
  const sumY = data.reduce((s, d) => s + d.y, 0);
  const sumXY = data.reduce((s, d) => s + d.x * d.y, 0);
  const sumXX = data.reduce((s, d) => s + d.x * d.x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

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
  const [error, setError] = useState<string | null>(null);
  const [cities, setCities] = useState<{id: string, name: string}[]>([]);
  const [selectedCity, setSelectedCity] = useState<string>('');

  useEffect(() => {
    const supabase = createBrowserClient();
    supabase.from('cities').select('id, name').eq('is_active', true).order('name')
      .then(({ data }) => { if (data) setCities(data); });
  }, []);
  // System health state
  const [health, setHealth] = useState({
    apiOk: false,
    dbOk: false,
    activeRides: 0,
    onlineDrivers: 0,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;

    async function fetchHealth() {
      const supabase = createBrowserClient();
      try {
        const [healthRes, dbRes, activeRes, driversRes] = await Promise.all([
          fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/health-check`).catch(() => null),
          supabase.from('rides').select('*', { count: 'exact', head: true }),
          supabase.from('rides')
            .select('*', { count: 'exact', head: true })
            .in('status', ['in_progress', 'driver_en_route', 'arrived_at_pickup']),
          supabase.from('driver_profiles')
            .select('*', { count: 'exact', head: true })
            .eq('is_online', true),
        ]);
        if (!cancelled) {
          setHealth({
            apiOk: healthRes?.ok ?? false,
            dbOk: !dbRes.error,
            activeRides: activeRes.count ?? 0,
            onlineDrivers: driversRes.count ?? 0,
            loading: false,
          });
        }
      } catch {
        if (!cancelled) {
          setHealth((prev) => ({ ...prev, loading: false }));
        }
      }
    }

    fetchHealth();
    const interval = setInterval(fetchHealth, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

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
        // Error handled by UI
        if (!cancelled) setError(err instanceof Error ? err.message : t('reports.load_error', { defaultValue: 'Error al cargar reportes' }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAll();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  // KPI cards
  const kpiCards = [
    { label: t('reports.active_rides'), value: metrics?.active_rides ?? 0, color: 'text-primary-500', desc: t('reports.desc_active_rides') },
    { label: t('reports.rides_today'), value: metrics?.total_rides_today ?? 0, color: 'text-ink', desc: t('reports.desc_rides_today') },
    { label: t('reports.online_drivers'), value: metrics?.online_drivers ?? 0, color: 'text-green-600', desc: t('reports.desc_online_drivers') },
    { label: t('reports.revenue_today'), value: formatCUP(metrics?.total_revenue_today ?? 0), color: 'text-primary-500', desc: t('reports.desc_revenue_today'), isFormatted: true },
    { label: t('reports.pending_verifications'), value: metrics?.pending_verifications ?? 0, color: 'text-yellow-600', desc: t('reports.desc_pending_verifications') },
    { label: t('reports.open_incidents'), value: metrics?.open_incidents ?? 0, color: 'text-red-600', desc: t('reports.desc_open_incidents') },
  ];

  // Revenue trend helpers
  const maxRevenue = Math.max(...ridesByDay.map((d) => d.revenue), 1);
  const maxRides = Math.max(...ridesByDay.map((d) => d.total), 1);

  // Revenue Forecast — linear regression on last 30 days, project next 7
  const forecastData: ForecastDay[] = (() => {
    if (ridesByDay.length < 2) return [];
    const regressionInput = ridesByDay.map((d, i) => ({ x: i, y: d.revenue }));
    const { slope, intercept } = linearRegression(regressionInput);

    const actual: ForecastDay[] = ridesByDay.map((d) => ({
      day: d.day,
      revenue: d.revenue,
      predicted: false,
    }));

    const lastDay = ridesByDay[ridesByDay.length - 1];
    const lastDate = lastDay ? new Date(lastDay.day) : new Date();
    const n = ridesByDay.length;

    const predicted: ForecastDay[] = Array.from({ length: 7 }, (_, i) => {
      const futureDate = new Date(lastDate);
      futureDate.setDate(futureDate.getDate() + i + 1);
      const predictedRevenue = Math.max(0, slope * (n + i) + intercept);
      return {
        day: futureDate.toISOString().split('T')[0]!,
        revenue: predictedRevenue,
        predicted: true,
      };
    });

    return [...actual, ...predicted];
  })();

  const forecastTotal = forecastData
    .filter((d) => d.predicted)
    .reduce((sum, d) => sum + d.revenue, 0);
  const maxForecastRevenue = Math.max(...forecastData.map((d) => d.revenue), 1);

  // Peak hours helpers
  const maxAvgRides = Math.max(...peakHours.map((h) => h.avg_rides), 1);

  // Service type total
  const serviceTotal = ridesByService.reduce((s, r) => s + r.count, 0) || 1;

  // Payment total
  const paymentTotal = ridesByPayment.reduce((s, r) => s + r.count, 0) || 1;

  // Utilization total
  const utilTotal = utilization ? utilization.busy + utilization.idle + utilization.offline : 1;

  // CSV Export
  const [exporting, setExporting] = useState(false);
  const exportCSV = useCallback(async () => {
    setExporting(true);
    try {
      const supabase = createBrowserClient();
      let csvQuery = supabase
        .from('rides')
        .select('created_at, service_type, status, estimated_fare_cup, final_fare_trc, payment_method, pickup_address, dropoff_address')
        .order('created_at', { ascending: false })
        .limit(1000);

      if (selectedCity) {
        csvQuery = csvQuery.eq('city_id', selectedCity);
      }

      const { data } = await csvQuery;

      if (!data?.length) return;

      const headers = [
        t('rides.csv_col_created', { defaultValue: 'Fecha' }),
        t('rides.type_all', { defaultValue: 'Tipo' }),
        t('rides.csv_col_status', { defaultValue: 'Estado' }),
        t('rides.csv_col_estimated_fare', { defaultValue: 'Tarifa CUP' }),
        'Tarifa TRC',
        t('rides.csv_col_payment_method', { defaultValue: 'Pago' }),
        t('rides.csv_col_origin', { defaultValue: 'Origen' }),
        t('rides.csv_col_destination', { defaultValue: 'Destino' }),
      ];
      const rows = data.map(r => [
        new Date(r.created_at).toLocaleDateString(),
        r.service_type, r.status,
        r.estimated_fare_cup, r.final_fare_trc,
        r.payment_method, r.pickup_address, r.dropoff_address,
      ]);

      const csv = [headers, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tricigo-rides-${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      // Error handled by UI
    } finally {
      setExporting(false);
    }
  }, [selectedCity]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
            {t('reports.page_eyebrow', { defaultValue: 'Sistema · reportes' })}
          </p>
          <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
            {t('reports.title', { defaultValue: 'Reportes operativos' })}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {t('reports.page_description', { defaultValue: 'Panorama analítico del servicio. Seleccioná el período para ver tendencias.' })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedCity}
            onChange={(e) => setSelectedCity(e.target.value)}
            aria-label={t('reports.filter_city_aria', { defaultValue: 'Filtrar por ciudad' })}
            className="h-9 rounded-lg border border-line bg-surface px-3 text-[12.5px] text-ink focus:border-primary-500 focus:outline-none"
          >
            <option value="">{t('reports.all_cities', { defaultValue: 'Todas las ciudades' })}</option>
            {cities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="flex gap-1 rounded-full border border-line bg-surface p-0.5">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                aria-pressed={period === opt.value}
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                  period === opt.value
                    ? 'bg-surface-elevated text-ink shadow-elev-1'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={exportCSV}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting
              ? t('reports.exporting', { defaultValue: 'Exportando…' })
              : t('reports.export_csv', { defaultValue: 'Exportar CSV' })}
          </button>
        </div>
      </div>

      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); setPeriod(p => p); }}
          onDismiss={() => setError(null)}
        />
      )}

      {loading && (
        <AdminTableSkeleton rows={5} columns={4} />
      )}

      {/* System Health — always visible, auto-refreshes every 30s */}
      <SectionCard
        eyebrow={t('reports.section_health_eyebrow', { defaultValue: 'Operación' })}
        title={t('reports.section_health_title', { defaultValue: 'Salud del sistema' })}
        description={t('reports.section_health_description', { defaultValue: 'Estado de los servicios core en tiempo real.' })}
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-sunken p-3">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${health.loading ? 'animate-pulse bg-ink-subtle' : health.apiOk ? 'bg-emerald-500' : 'bg-red-500'}`} />
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">{t('reports.health_api', { defaultValue: 'API' })}</p>
              <p className={`text-[12.5px] font-semibold ${health.apiOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {health.loading ? '…' : health.apiOk ? t('reports.health_ok', { defaultValue: 'Operativa' }) : t('reports.health_down', { defaultValue: 'Caída' })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-sunken p-3">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${health.loading ? 'animate-pulse bg-ink-subtle' : health.dbOk ? 'bg-emerald-500' : 'bg-red-500'}`} />
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">{t('reports.health_db', { defaultValue: 'Base de datos' })}</p>
              <p className={`text-[12.5px] font-semibold ${health.dbOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {health.loading ? '…' : health.dbOk ? t('reports.health_ok', { defaultValue: 'Operativa' }) : t('reports.health_down', { defaultValue: 'Caída' })}
              </p>
            </div>
          </div>
          <div className="rounded-xl border border-line bg-surface-sunken p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">{t('reports.health_active_rides', { defaultValue: 'Viajes activos' })}</p>
            <p className="font-editorial text-[28px] leading-none italic text-primary-500" data-tabular>
              {health.loading ? '—' : health.activeRides}
            </p>
          </div>
          <div className="rounded-xl border border-line bg-surface-sunken p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-subtle">{t('reports.health_online_drivers', { defaultValue: 'Conductores en línea' })}</p>
            <p className="font-editorial text-[28px] leading-none italic text-emerald-600 dark:text-emerald-400" data-tabular>
              {health.loading ? '—' : health.onlineDrivers}
            </p>
          </div>
        </div>
      </SectionCard>

      {!loading && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            {kpiCards.map((card) => (
              <KpiCard
                key={card.label}
                label={card.label}
                value={card.isFormatted ? String(card.value) : String(card.value)}
              />
            ))}
          </div>

          {/* Revenue Trend */}
          <section className="bg-surface-elevated rounded-xl p-6 shadow-sm border border-line mb-6">
            <h2 className="text-lg font-bold text-ink mb-4">{t('reports.revenue_trend')}</h2>
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
            <div className="flex justify-between mt-2 text-xs text-ink-subtle">
              <span>{ridesByDay[0]?.day ? new Date(ridesByDay[0].day).toLocaleDateString('es-CU', { month: 'short', day: 'numeric' }) : ''}</span>
              <span>{ridesByDay[ridesByDay.length - 1]?.day ? new Date(ridesByDay[ridesByDay.length - 1]!.day).toLocaleDateString('es-CU', { month: 'short', day: 'numeric' }) : ''}</span>
            </div>
          </section>

          {/* Revenue Forecast */}
          {forecastData.length > 0 && (
            <section className="bg-surface-elevated rounded-xl p-6 shadow-sm border border-line mb-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-ink">{t('reports.revenue_forecast')}</h2>
                <div className="text-sm font-semibold text-primary-600 bg-primary-50 px-3 py-1 rounded-full">
                  {t('reports.prediction_next_7_days')}: {forecastTotal.toFixed(1)} TRC
                </div>
              </div>
              <div className="flex items-end gap-[2px] h-40">
                {forecastData.map((d) => (
                  <div
                    key={d.day}
                    className="flex-1 group relative"
                    title={`${d.day}: ${d.revenue.toFixed(1)} TRC ${d.predicted ? `(${t('reports.predicted')})` : `(${t('reports.actual')})`}`}
                  >
                    <div
                      className={`w-full rounded-t-sm transition-all ${
                        d.predicted
                          ? 'bg-primary-300/50 hover:bg-primary-400/60'
                          : 'bg-primary-500/80 hover:bg-primary-600'
                      }`}
                      style={{
                        height: `${Math.max((d.revenue / maxForecastRevenue) * 100, 2)}%`,
                        backgroundImage: d.predicted
                          ? 'repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(255,255,255,0.3) 3px, rgba(255,255,255,0.3) 6px)'
                          : undefined,
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-between mt-2 text-xs text-ink-subtle">
                <span>
                  {forecastData[0]?.day
                    ? new Date(forecastData[0].day).toLocaleDateString('es-CU', { month: 'short', day: 'numeric' })
                    : ''}
                </span>
                <span className="text-primary-400 font-medium">← {t('reports.predicted')} →</span>
                <span>
                  {forecastData[forecastData.length - 1]?.day
                    ? new Date(forecastData[forecastData.length - 1]!.day).toLocaleDateString('es-CU', { month: 'short', day: 'numeric' })
                    : ''}
                </span>
              </div>
              {/* Legend */}
              <div className="flex items-center gap-4 mt-3 text-xs text-ink-subtle">
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-primary-500/80" />
                  <span>{t('reports.actual')}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className="w-3 h-3 rounded-sm bg-primary-300/50"
                    style={{
                      backgroundImage:
                        'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.4) 2px, rgba(255,255,255,0.4) 4px)',
                    }}
                  />
                  <span>{t('reports.predicted')}</span>
                </div>
              </div>
            </section>
          )}

          {/* Two-column grid: Service Type + Payment Method */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* Rides by Service Type */}
            <section className="bg-surface-elevated rounded-xl p-6 shadow-sm border border-line">
              <h2 className="text-lg font-bold text-ink mb-4">{t('reports.rides_by_service')}</h2>
              <div className="space-y-3">
                {ridesByService.map((s, i) => {
                  const pct = Math.round((s.count / serviceTotal) * 100);
                  return (
                    <div key={s.service_type}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-ink font-medium">{s.service_type}</span>
                        <span className="text-ink-muted">{s.count} ({pct}%)</span>
                      </div>
                      <div className="w-full bg-surface-sunken rounded-full h-2.5">
                        <div
                          className={`h-2.5 rounded-full ${BAR_COLORS[i % BAR_COLORS.length]}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
                {ridesByService.length === 0 && (
                  <p className="text-sm text-ink-subtle">{t('reports.no_data')}</p>
                )}
              </div>
            </section>

            {/* Rides by Payment Method */}
            <section className="bg-surface-elevated rounded-xl p-6 shadow-sm border border-line">
              <h2 className="text-lg font-bold text-ink mb-4">{t('reports.rides_by_payment')}</h2>
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
                        <span className="text-ink font-medium">{label}</span>
                        <span className="text-ink-muted">{p.count} ({pct}%) — {formatCUP(p.revenue)}</span>
                      </div>
                      <div className="w-full bg-surface-sunken rounded-full h-2.5">
                        <div
                          className={`h-2.5 rounded-full ${BAR_COLORS[i % BAR_COLORS.length]}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
                {ridesByPayment.length === 0 && (
                  <p className="text-sm text-ink-subtle">{t('reports.no_data')}</p>
                )}
              </div>
            </section>
          </div>

          {/* Peak Hours */}
          <section className="bg-surface-elevated rounded-xl p-6 shadow-sm border border-line mb-6">
            <h2 className="text-lg font-bold text-ink mb-4">{t('reports.peak_hours')}</h2>
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
            <div className="flex justify-between mt-2 text-xs text-ink-subtle">
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
            <section className="bg-surface-elevated rounded-xl p-6 shadow-sm border border-line lg:col-span-2">
              <h2 className="text-lg font-bold text-ink mb-4">{t('reports.top_drivers')}</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="text-left py-2 text-ink-muted font-medium">#</th>
                      <th className="text-left py-2 text-ink-muted font-medium">{t('drivers.col_name')}</th>
                      <th className="text-right py-2 text-ink-muted font-medium">{t('reports.rides_label')}</th>
                      <th className="text-right py-2 text-ink-muted font-medium">{t('drivers.col_rating')}</th>
                      <th className="text-right py-2 text-ink-muted font-medium">{t('reports.revenue_label')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topDrivers.map((d, i) => (
                      <tr key={d.driver_id} className="border-b border-line">
                        <td className="py-2 text-ink-subtle">{i + 1}</td>
                        <td className="py-2 text-ink font-medium">{d.driver_name}</td>
                        <td className="py-2 text-right text-ink-muted">{d.rides_count}</td>
                        <td className="py-2 text-right text-ink-muted">{Number(d.rating).toFixed(1)}</td>
                        <td className="py-2 text-right text-ink-muted">{formatCUP(d.revenue)}</td>
                      </tr>
                    ))}
                    {topDrivers.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-ink-subtle">{t('reports.no_data')}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Driver Utilization */}
            <section className="bg-surface-elevated rounded-xl p-6 shadow-sm border border-line">
              <h2 className="text-lg font-bold text-ink mb-4">{t('reports.driver_utilization')}</h2>
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
                        <span className="text-ink-muted">{t('reports.util_busy')}</span>
                      </div>
                      <span className="font-medium">{utilization.busy}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full bg-amber-400" />
                        <span className="text-ink-muted">{t('reports.util_idle')}</span>
                      </div>
                      <span className="font-medium">{utilization.idle}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full bg-neutral-300" />
                        <span className="text-ink-muted">{t('reports.util_offline')}</span>
                      </div>
                      <span className="font-medium">{utilization.offline}</span>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-line">
                    <p className="text-xs text-ink-subtle">
                      {t('reports.total_online')}: <strong>{utilization.online}</strong>
                    </p>
                  </div>
                </div>
              )}
            </section>
          </div>

          {/* Wallet section */}
          <section className="mb-6">
            <h2 className="text-lg font-bold text-ink mb-4">{t('reports.section_finance')}</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-surface-elevated rounded-xl p-6 shadow-sm border border-line">
                <p className="text-sm text-ink-muted mb-1">{t('reports.circulation')}</p>
                <p className="text-2xl font-bold text-primary-500">{formatTriciCoin(walletStats?.total_in_circulation ?? 0)}</p>
              </div>
              <div className="bg-surface-elevated rounded-xl p-6 shadow-sm border border-line">
                <p className="text-sm text-ink-muted mb-1">{t('reports.pending_redemptions')}</p>
                <p className="text-2xl font-bold text-yellow-600">{walletStats?.pending_redemptions_count ?? 0}</p>
              </div>
              <div className="bg-surface-elevated rounded-xl p-6 shadow-sm border border-line">
                <p className="text-sm text-ink-muted mb-1">{t('reports.pending_amount')}</p>
                <p className="text-2xl font-bold text-ink">{formatTriciCoin(walletStats?.pending_redemptions_amount ?? 0)}</p>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
