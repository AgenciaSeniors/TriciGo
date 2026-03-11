'use client';

import { useEffect, useState, useCallback } from 'react';
import { referralService } from '@tricigo/api/services/referral';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { Referral, ReferralStatus } from '@tricigo/types';

const PAGE_SIZE = 20;

const STATUS_TABS: { labelKey: string; value: string }[] = [
  { labelKey: 'referrals.filter_all', value: 'all' },
  { labelKey: 'referrals.filter_pending', value: 'pending' },
  { labelKey: 'referrals.filter_rewarded', value: 'rewarded' },
  { labelKey: 'referrals.filter_invalidated', value: 'invalidated' },
];

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  rewarded: 'bg-green-100 text-green-800',
  invalidated: 'bg-red-100 text-red-800',
};

export default function ReferralsPage() {
  const { t } = useTranslation('admin');

  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState('all');
  const [stats, setStats] = useState({
    total: 0,
    pending: 0,
    rewarded: 0,
    invalidated: 0,
    total_bonus_paid_cup: 0,
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const statusFilter = filter === 'all' ? undefined : (filter as ReferralStatus);
      const [result, statsData] = await Promise.all([
        referralService.getAllReferrals(page, PAGE_SIZE, statusFilter),
        referralService.getReferralStats(),
      ]);
      setReferrals(result.data);
      setTotal(result.total);
      setStats(statsData);
    } catch (err) {
      console.error('Error fetching referrals:', err);
    } finally {
      setLoading(false);
    }
  }, [page, filter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleReward = async (ref: Referral) => {
    if (!window.confirm(t('referrals.reward_confirm'))) return;
    try {
      await referralService.rewardReferral(ref.id);
      window.alert(t('referrals.reward_success'));
      fetchData();
    } catch (err) {
      console.error('Error rewarding referral:', err);
      window.alert('Error: ' + (err instanceof Error ? err.message : 'Unknown'));
    }
  };

  const handleInvalidate = async (ref: Referral) => {
    if (!window.confirm(t('referrals.invalidate_confirm'))) return;
    try {
      await referralService.invalidateReferral(ref.id);
      window.alert(t('referrals.invalidate_success'));
      fetchData();
    } catch (err) {
      console.error('Error invalidating referral:', err);
      window.alert('Error: ' + (err instanceof Error ? err.message : 'Unknown'));
    }
  };

  const conversionRate =
    stats.total > 0 ? ((stats.rewarded / stats.total) * 100).toFixed(1) : '0';

  const canGoPrev = page > 0;
  const canGoNext = referrals.length === PAGE_SIZE;

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">{t('referrals.title')}</h1>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <StatCard label={t('referrals.total')} value={stats.total} />
        <StatCard
          label={t('referrals.pending')}
          value={stats.pending}
          color="text-yellow-600"
        />
        <StatCard
          label={t('referrals.rewarded')}
          value={stats.rewarded}
          color="text-green-600"
        />
        <StatCard
          label={t('referrals.invalidated')}
          value={stats.invalidated}
          color="text-red-600"
        />
        <StatCard
          label={t('referrals.total_bonus_paid')}
          value={formatCUP(stats.total_bonus_paid_cup)}
          color="text-primary-600"
        />
      </div>

      {/* Conversion rate */}
      <div className="mb-6 text-sm text-neutral-500">
        {t('referrals.conversion_rate')}: <span className="font-semibold text-neutral-800">{conversionRate}%</span>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-6">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => { setFilter(tab.value); setPage(0); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === tab.value
                ? 'bg-primary-500 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <p className="text-neutral-400">{t('common.loading')}</p>
      ) : referrals.length === 0 ? (
        <p className="text-neutral-400 py-12 text-center">{t('referrals.no_referrals')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-neutral-500">
                <th className="pb-3 pr-4">{t('referrals.col_referrer')}</th>
                <th className="pb-3 pr-4">{t('referrals.col_referee')}</th>
                <th className="pb-3 pr-4">{t('referrals.col_code')}</th>
                <th className="pb-3 pr-4">{t('referrals.col_status')}</th>
                <th className="pb-3 pr-4">{t('referrals.col_bonus')}</th>
                <th className="pb-3 pr-4">{t('referrals.col_date')}</th>
                <th className="pb-3">{t('referrals.col_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {referrals.map((ref) => (
                <tr key={ref.id} className="border-b hover:bg-neutral-50">
                  <td className="py-3 pr-4 font-mono text-xs">
                    {ref.referrer_id.substring(0, 8)}...
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs">
                    {ref.referee_id.substring(0, 8)}...
                  </td>
                  <td className="py-3 pr-4 font-semibold tracking-wider">
                    {ref.code}
                  </td>
                  <td className="py-3 pr-4">
                    <span
                      className={`px-2 py-1 rounded-full text-xs font-medium ${
                        STATUS_COLOR[ref.status] ?? 'bg-neutral-100 text-neutral-600'
                      }`}
                    >
                      {t(`referrals.filter_${ref.status}`)}
                    </span>
                  </td>
                  <td className="py-3 pr-4">{formatCUP(ref.bonus_amount)}</td>
                  <td className="py-3 pr-4 text-neutral-500">
                    {new Date(ref.created_at).toLocaleDateString('es-CU', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </td>
                  <td className="py-3">
                    {ref.status === 'pending' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleReward(ref)}
                          className="px-3 py-1 rounded text-xs font-medium bg-green-100 text-green-700 hover:bg-green-200"
                        >
                          {t('referrals.reward')}
                        </button>
                        <button
                          onClick={() => handleInvalidate(ref)}
                          className="px-3 py-1 rounded text-xs font-medium bg-red-100 text-red-700 hover:bg-red-200"
                        >
                          {t('referrals.invalidate')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {(canGoPrev || canGoNext) && (
        <div className="flex items-center justify-between mt-6 text-sm">
          <button
            disabled={!canGoPrev}
            onClick={() => setPage((p) => p - 1)}
            className={`px-4 py-2 rounded-lg ${
              canGoPrev
                ? 'bg-neutral-100 hover:bg-neutral-200 text-neutral-700'
                : 'bg-neutral-50 text-neutral-300 cursor-not-allowed'
            }`}
          >
            {t('common.previous')}
          </button>
          <span className="text-neutral-500">
            {t('common.page')} {page + 1}
          </span>
          <button
            disabled={!canGoNext}
            onClick={() => setPage((p) => p + 1)}
            className={`px-4 py-2 rounded-lg ${
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
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="bg-white rounded-xl border p-4">
      <p className="text-xs text-neutral-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color ?? 'text-neutral-900'}`}>
        {value}
      </p>
    </div>
  );
}
