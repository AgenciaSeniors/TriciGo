'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { createBrowserClient } from '@/lib/supabase-server';

type FunnelStep = {
  key: string;
  labelKey: string;
  count: number;
};

export default function FunnelPage() {
  const { t } = useTranslation('admin');
  const [loading, setLoading] = useState(true);
  const [steps, setSteps] = useState<FunnelStep[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function fetchFunnelData() {
      try {
        const supabase = createBrowserClient();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const since = thirtyDaysAgo.toISOString();

        const [sessionsRes, searchesRes, requestsRes, acceptedRes, completedRes] =
          await Promise.all([
            // Step 1: Sessions — distinct customers who had rides in last 30 days
            supabase
              .from('rides')
              .select('customer_id', { count: 'exact', head: false })
              .gte('created_at', since),

            // Step 2: Searches — rides with estimated fare > 0
            supabase
              .from('rides')
              .select('*', { count: 'exact', head: true })
              .gte('created_at', since)
              .gt('estimated_fare_cup', 0),

            // Step 3: Requests — rides created (status != draft)
            supabase
              .from('rides')
              .select('*', { count: 'exact', head: true })
              .gte('created_at', since)
              .neq('status', 'draft'),

            // Step 4: Accepted — rides where driver accepted
            supabase
              .from('rides')
              .select('*', { count: 'exact', head: true })
              .gte('created_at', since)
              .in('status', ['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'completed']),

            // Step 5: Completed rides
            supabase
              .from('rides')
              .select('*', { count: 'exact', head: true })
              .gte('created_at', since)
              .eq('status', 'completed'),
          ]);

        if (cancelled) return;

        // Count distinct customers for sessions
        const uniqueCustomers = sessionsRes.data
          ? new Set(sessionsRes.data.map((r: { customer_id: string }) => r.customer_id)).size
          : 0;

        setSteps([
          { key: 'sessions', labelKey: 'funnel.sessions', count: uniqueCustomers },
          { key: 'searches', labelKey: 'funnel.searches', count: searchesRes.count ?? 0 },
          { key: 'requests', labelKey: 'funnel.requests', count: requestsRes.count ?? 0 },
          { key: 'accepted', labelKey: 'funnel.accepted', count: acceptedRes.count ?? 0 },
          { key: 'completed', labelKey: 'funnel.completed', count: completedRes.count ?? 0 },
        ]);
      } catch (err) {
        console.error('Error fetching funnel data:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchFunnelData();
    return () => { cancelled = true; };
  }, []);

  const maxCount = Math.max(...steps.map((s) => s.count), 1);

  // Funnel colors — gradient from wide (green) to narrow (primary)
  const FUNNEL_COLORS = [
    'bg-green-500',
    'bg-emerald-500',
    'bg-primary-400',
    'bg-primary-500',
    'bg-primary-600',
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">{t('funnel.title')}</h1>
        <span className="text-sm text-neutral-500">{t('funnel.last_30_days')}</span>
      </div>

      {loading && (
        <div className="text-center py-12 text-neutral-400">{t('common.loading')}</div>
      )}

      {!loading && steps.length > 0 && (
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
          <div className="space-y-1">
            {steps.map((step, i) => {
              const prevCount = i > 0 ? steps[i - 1]!.count : 0;
              const conversionRate = i > 0 && prevCount > 0
                ? ((step.count / prevCount) * 100).toFixed(1)
                : null;
              const widthPct = maxCount > 0
                ? Math.max((step.count / maxCount) * 100, 8)
                : 8;

              return (
                <div key={step.key}>
                  {/* Conversion rate between steps */}
                  {conversionRate !== null && (
                    <div className="flex items-center justify-center py-1.5">
                      <div className="flex items-center gap-2 text-xs text-neutral-400">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                        </svg>
                        <span className="font-semibold text-neutral-600">{conversionRate}%</span>
                        <span>{t('funnel.conversion_rate')}</span>
                      </div>
                    </div>
                  )}

                  {/* Funnel bar */}
                  <div className="flex items-center justify-center">
                    <div
                      className="relative transition-all duration-500"
                      style={{ width: `${widthPct}%`, minWidth: '120px' }}
                    >
                      <div
                        className={`${FUNNEL_COLORS[i % FUNNEL_COLORS.length]} rounded-lg py-4 px-4 text-white text-center relative overflow-hidden`}
                      >
                        {/* Subtle gradient overlay */}
                        <div className="absolute inset-0 bg-gradient-to-b from-white/10 to-transparent" />
                        <div className="relative">
                          <div className="text-xs font-medium opacity-80 uppercase tracking-wide mb-0.5">
                            {t('funnel.step')} {i + 1}
                          </div>
                          <div className="text-lg font-bold">{step.count.toLocaleString()}</div>
                          <div className="text-sm font-medium">{t(step.labelKey)}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Summary table */}
          <div className="mt-8 border-t border-neutral-100 pt-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-100">
                  <th className="text-left py-2 text-neutral-500 font-medium">{t('funnel.step')}</th>
                  <th className="text-left py-2 text-neutral-500 font-medium">
                    {/* Label column */}
                  </th>
                  <th className="text-right py-2 text-neutral-500 font-medium">#</th>
                  <th className="text-right py-2 text-neutral-500 font-medium">{t('funnel.conversion_rate')}</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step, i) => {
                  const prevCount = i > 0 ? steps[i - 1]!.count : 0;
                  const rate = i > 0 && prevCount > 0
                    ? ((step.count / prevCount) * 100).toFixed(1)
                    : '—';
                  const overallRate = steps[0]!.count > 0
                    ? ((step.count / steps[0]!.count) * 100).toFixed(1)
                    : '0';
                  return (
                    <tr key={step.key} className="border-b border-neutral-50">
                      <td className="py-2.5 text-neutral-400">{i + 1}</td>
                      <td className="py-2.5 text-neutral-900 font-medium">{t(step.labelKey)}</td>
                      <td className="py-2.5 text-right text-neutral-700 font-semibold">{step.count.toLocaleString()}</td>
                      <td className="py-2.5 text-right">
                        <span className={`font-medium ${i === 0 ? 'text-neutral-400' : Number(rate) >= 50 ? 'text-green-600' : Number(rate) >= 20 ? 'text-amber-600' : 'text-red-500'}`}>
                          {rate}{rate !== '—' ? '%' : ''}
                        </span>
                        {i > 0 && (
                          <span className="text-xs text-neutral-400 ml-2">
                            ({overallRate}% total)
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && steps.length === 0 && (
        <div className="text-center py-12 text-neutral-400">{t('reports.no_data')}</div>
      )}
    </div>
  );
}
