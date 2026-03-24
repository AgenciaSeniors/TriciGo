'use client';

import { useEffect, useState } from 'react';
import { createBrowserClient } from '@/lib/supabase-server';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { AdminEmptyState } from '@/components/ui/AdminEmptyState';

type AcceptRateRow = {
  profit_level: string;
  total: number;
  accepted: number;
  rejected: number;
  accept_rate: number;
};

type NavRateRow = {
  total: number;
  triggered: number;
  cancelled: number;
  follow_rate: number;
};

type OverrideRow = {
  driver_id: string;
  total_overrides: number;
  reject_count: number;
  nav_cancel_count: number;
};

const DAYS_OPTIONS = [
  { label: '7d', value: 7 },
  { label: '14d', value: 14 },
  { label: '30d', value: 30 },
];

function rateColor(rate: number, greenThreshold: number, amberThreshold: number): string {
  if (rate >= greenThreshold) return 'text-green-600';
  if (rate >= amberThreshold) return 'text-amber-600';
  return 'text-red-600';
}

function rateBg(rate: number, greenThreshold: number, amberThreshold: number): string {
  if (rate >= greenThreshold) return 'bg-green-50 border-green-200';
  if (rate >= amberThreshold) return 'bg-amber-50 border-amber-200';
  return 'bg-red-50 border-red-200';
}

export default function ValidationPage() {
  const [daysBack, setDaysBack] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [acceptRates, setAcceptRates] = useState<AcceptRateRow[]>([]);
  const [navRate, setNavRate] = useState<NavRateRow | null>(null);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function fetchAll() {
      const supabase = createBrowserClient();

      try {
        const [acceptRes, navRes, overrideRes] = await Promise.all([
          supabase.rpc('get_auto_accept_rate', { p_days_back: daysBack }),
          supabase.rpc('get_auto_nav_rate', { p_days_back: daysBack }),
          supabase.rpc('get_override_frequency', { p_days_back: daysBack, p_limit: 20 }),
        ]);

        if (acceptRes.error) throw acceptRes.error;
        if (navRes.error) throw navRes.error;
        if (overrideRes.error) throw overrideRes.error;

        if (!cancelled) {
          setAcceptRates(acceptRes.data ?? []);
          // navRes.data is an array with a single row
          const navRows = navRes.data as NavRateRow[] | null;
          setNavRate(navRows && navRows.length > 0 ? navRows[0] : null);
          setOverrides(overrideRes.data ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Error loading validation data');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAll();
    return () => { cancelled = true; };
  }, [daysBack]);

  const followRate = navRate?.follow_rate ?? 0;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">Validation Dashboard</h1>
        <div className="flex gap-1 bg-neutral-100 rounded-lg p-1">
          {DAYS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setDaysBack(opt.value)}
              aria-pressed={daysBack === opt.value}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                daysBack === opt.value
                  ? 'bg-white text-neutral-900 shadow-sm'
                  : 'text-neutral-500 hover:text-neutral-700'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); setDaysBack((d) => d); }}
          onDismiss={() => setError(null)}
        />
      )}

      {loading && <AdminTableSkeleton rows={5} columns={4} />}

      {!loading && (
        <>
          {/* Section 1: Auto-Accept Rates */}
          <section className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 mb-6">
            <h2 className="text-lg font-bold text-neutral-800 mb-4">Auto-Accept Rates by Profit Level</h2>
            {acceptRates.length === 0 ? (
              <AdminEmptyState message="No auto-accept data for this period" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-100">
                      <th className="text-left py-2 text-neutral-500 font-medium">Profit Level</th>
                      <th className="text-right py-2 text-neutral-500 font-medium">Total</th>
                      <th className="text-right py-2 text-neutral-500 font-medium">Accepted</th>
                      <th className="text-right py-2 text-neutral-500 font-medium">Rejected</th>
                      <th className="text-right py-2 text-neutral-500 font-medium">Accept Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acceptRates.map((row) => (
                      <tr key={row.profit_level ?? 'unknown'} className="border-b border-neutral-50">
                        <td className="py-2 text-neutral-900 font-medium">
                          {row.profit_level ?? 'Unknown'}
                        </td>
                        <td className="py-2 text-right text-neutral-600">{row.total}</td>
                        <td className="py-2 text-right text-neutral-600">{row.accepted}</td>
                        <td className="py-2 text-right text-neutral-600">{row.rejected}</td>
                        <td className={`py-2 text-right font-semibold ${rateColor(row.accept_rate, 85, 70)}`}>
                          {row.accept_rate}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Section 2: Auto-Nav Follow Rate */}
          <section className="mb-6">
            <h2 className="text-lg font-bold text-neutral-800 mb-4">Auto-Nav Follow Rate</h2>
            <div
              className={`rounded-xl p-6 shadow-sm border ${rateBg(followRate, 70, 50)}`}
            >
              <p className={`text-4xl font-bold ${rateColor(followRate, 70, 50)}`}>
                {navRate ? `${followRate}%` : '--'}
              </p>
              <p className="text-sm text-neutral-500 mt-1">follow rate</p>
              {navRate && (
                <p className="text-sm text-neutral-600 mt-3">
                  {navRate.triggered} triggered, {navRate.cancelled} cancelled
                </p>
              )}
              {!navRate && (
                <p className="text-sm text-neutral-400 mt-3">No auto-nav data for this period</p>
              )}
            </div>
          </section>

          {/* Section 3: Top Overriders */}
          <section className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 mb-6">
            <h2 className="text-lg font-bold text-neutral-800 mb-4">Top Overriders</h2>
            {overrides.length === 0 ? (
              <AdminEmptyState message="No override data for this period" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-100">
                      <th className="text-left py-2 text-neutral-500 font-medium">Driver ID</th>
                      <th className="text-right py-2 text-neutral-500 font-medium">Total Overrides</th>
                      <th className="text-right py-2 text-neutral-500 font-medium">Rejections</th>
                      <th className="text-right py-2 text-neutral-500 font-medium">Nav Cancels</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overrides.map((row) => (
                      <tr
                        key={row.driver_id}
                        className={`border-b border-neutral-50 ${
                          row.total_overrides > 10 ? 'bg-amber-50' : ''
                        }`}
                      >
                        <td className="py-2 text-neutral-900 font-mono text-xs">
                          {row.driver_id.slice(0, 8)}...
                        </td>
                        <td className={`py-2 text-right font-semibold ${
                          row.total_overrides > 10 ? 'text-amber-700' : 'text-neutral-600'
                        }`}>
                          {row.total_overrides}
                        </td>
                        <td className="py-2 text-right text-neutral-600">{row.reject_count}</td>
                        <td className="py-2 text-right text-neutral-600">{row.nav_cancel_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
