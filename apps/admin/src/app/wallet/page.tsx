'use client';

import { useEffect, useState } from 'react';
import { adminService } from '@tricigo/api/services/admin';
import { formatTriciCoin } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useAdminUser } from '@/lib/useAdminUser';
import type { LedgerTransaction, WalletRedemption, WalletRechargeRequest } from '@tricigo/types';

const PAGE_SIZE = 20;

type Tab = 'redemptions' | 'recharges' | 'ledger';

type RechargeRow = WalletRechargeRequest & { user_name: string };

type WalletStats = {
  total_in_circulation: number;
  pending_redemptions_count: number;
  pending_redemptions_amount: number;
};

type RedemptionRow = WalletRedemption & { driver_name: string };

export default function WalletPage() {
  const { userId: adminUserId } = useAdminUser();
  const { t } = useTranslation('admin');
  const [stats, setStats] = useState<WalletStats | null>(null);
  const [tab, setTab] = useState<Tab>('redemptions');
  const [redemptions, setRedemptions] = useState<RedemptionRow[]>([]);
  const [recharges, setRecharges] = useState<RechargeRow[]>([]);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [processing, setProcessing] = useState<string | null>(null);

  // Fetch stats on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchStats() {
      try {
        const data = await adminService.getWalletStats();
        if (!cancelled) setStats(data);
      } catch (err) {
        console.error('Error fetching wallet stats:', err);
      }
    }
    fetchStats();
    return () => { cancelled = true; };
  }, []);

  // Fetch tab data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function fetchTabData() {
      try {
        if (tab === 'redemptions') {
          const data = await adminService.getPendingRedemptions(page, PAGE_SIZE);
          if (!cancelled) setRedemptions(data);
        } else if (tab === 'recharges') {
          const data = await adminService.getPendingRecharges(page, PAGE_SIZE);
          if (!cancelled) setRecharges(data as RechargeRow[]);
        } else {
          const data = await adminService.getAdminTransactions(page, PAGE_SIZE);
          if (!cancelled) setTransactions(data);
        }
      } catch (err) {
        console.error('Error fetching wallet data:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchTabData();
    return () => { cancelled = true; };
  }, [tab, page]);

  async function handleRedemption(id: string, action: 'approved' | 'rejected') {
    if (action === 'approved') {
      if (!window.confirm(t('wallet_admin.confirm_approve_redemption'))) return;
    } else {
      const reason = window.prompt(t('wallet_admin.reject_reason_redemption'));
      if (reason === null) return;
      setProcessing(id);
      try {
        await adminService.processRedemption(id, adminUserId, action, reason);
        setRedemptions((prev) => prev.filter((r) => r.id !== id));
        // Refresh stats
        const newStats = await adminService.getWalletStats();
        setStats(newStats);
      } catch (err) {
        console.error('Error processing redemption:', err);
        window.alert(t('wallet_admin.error_processing_redemption'));
      } finally {
        setProcessing(null);
      }
      return;
    }

    setProcessing(id);
    try {
      await adminService.processRedemption(id, adminUserId, action);
      setRedemptions((prev) => prev.filter((r) => r.id !== id));
      const newStats = await adminService.getWalletStats();
      setStats(newStats);
    } catch (err) {
      console.error('Error processing redemption:', err);
      window.alert(t('wallet_admin.error_processing_redemption'));
    } finally {
      setProcessing(null);
    }
  }

  async function handleRecharge(id: string, action: 'approved' | 'rejected') {
    if (action === 'approved') {
      if (!window.confirm(t('wallet_admin.confirm_approve_recharge'))) return;
    } else {
      const reason = window.prompt(t('wallet_admin.reject_reason_recharge'));
      if (reason === null) return;
      setProcessing(id);
      try {
        await adminService.processRecharge(id, adminUserId, false, reason);
        setRecharges((prev) => prev.filter((r) => r.id !== id));
      } catch (err) {
        console.error('Error processing recharge:', err);
        window.alert(t('wallet_admin.error_processing_recharge'));
      } finally {
        setProcessing(null);
      }
      return;
    }

    setProcessing(id);
    try {
      await adminService.processRecharge(id, adminUserId, true);
      setRecharges((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      console.error('Error processing recharge:', err);
      window.alert(t('wallet_admin.error_processing_recharge'));
    } finally {
      setProcessing(null);
    }
  }

  const tabs: { labelKey: string; value: Tab }[] = [
    { labelKey: 'wallet_admin.tab_redemptions', value: 'redemptions' },
    { labelKey: 'wallet_admin.tab_recharges', value: 'recharges' },
    { labelKey: 'wallet_admin.tab_ledger', value: 'ledger' },
  ];

  const listData = tab === 'redemptions' ? redemptions : tab === 'recharges' ? recharges : transactions;
  const canGoPrev = page > 0;
  const canGoNext = listData.length === PAGE_SIZE;

  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold mb-6">{t('wallet_admin.title')}</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
          <p className="text-sm text-neutral-500 mb-1">{t('wallet_admin.label_circulation')}</p>
          <p className="text-2xl font-bold text-primary-500">
            {stats ? formatTriciCoin(stats.total_in_circulation) : '—'}
          </p>
        </div>
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
          <p className="text-sm text-neutral-500 mb-1">{t('wallet_admin.label_pending_redemptions')}</p>
          <p className="text-2xl font-bold text-yellow-600">
            {stats?.pending_redemptions_count ?? '—'}
          </p>
        </div>
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
          <p className="text-sm text-neutral-500 mb-1">{t('wallet_admin.label_pending_amount')}</p>
          <p className="text-2xl font-bold">
            {stats ? formatTriciCoin(stats.pending_redemptions_amount) : '—'}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {tabs.map((tb) => (
          <button
            key={tb.value}
            onClick={() => { setTab(tb.value); setPage(0); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === tb.value
                ? 'bg-primary-500 text-white'
                : 'bg-white text-neutral-600 border border-neutral-200 hover:border-neutral-300'
            }`}
          >
            {t(tb.labelKey)}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <div className="overflow-x-auto">
        {tab === 'redemptions' ? (
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap">{t('wallet_admin.col_driver')}</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap">{t('wallet_admin.col_amount')}</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap hidden lg:table-cell">{t('wallet_admin.col_date')}</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {redemptions.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-12 text-neutral-400">
                    {loading ? t('common.loading') : t('wallet_admin.no_redemptions')}
                  </td>
                </tr>
              ) : (
                redemptions.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                    <td className="px-4 py-3 font-medium text-neutral-900">
                      {r.driver_name}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {formatTriciCoin(r.amount)}
                    </td>
                    <td className="px-4 py-3 text-neutral-500 hidden lg:table-cell">
                      {new Date(r.requested_at).toLocaleDateString('es-CU', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleRedemption(r.id, 'approved')}
                          disabled={processing === r.id}
                          className="px-3 py-1 rounded-lg text-xs font-medium bg-green-100 text-green-700 hover:bg-green-200 disabled:opacity-50"
                        >
                          {t('common.approve')}
                        </button>
                        <button
                          onClick={() => handleRedemption(r.id, 'rejected')}
                          disabled={processing === r.id}
                          className="px-3 py-1 rounded-lg text-xs font-medium bg-red-100 text-red-700 hover:bg-red-200 disabled:opacity-50"
                        >
                          {t('common.reject')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : tab === 'recharges' ? (
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap">{t('wallet_admin.col_user')}</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap">{t('wallet_admin.col_amount')}</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap hidden lg:table-cell">{t('wallet_admin.col_date')}</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {recharges.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-12 text-neutral-400">
                    {loading ? t('common.loading') : t('wallet_admin.no_recharges')}
                  </td>
                </tr>
              ) : (
                recharges.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                    <td className="px-4 py-3 font-medium text-neutral-900">
                      {r.user_name}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {formatTriciCoin(r.amount)}
                    </td>
                    <td className="px-4 py-3 text-neutral-500 hidden lg:table-cell">
                      {new Date(r.created_at).toLocaleDateString('es-CU', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleRecharge(r.id, 'approved')}
                          disabled={processing === r.id}
                          className="px-3 py-1 rounded-lg text-xs font-medium bg-green-100 text-green-700 hover:bg-green-200 disabled:opacity-50"
                        >
                          {t('common.approve')}
                        </button>
                        <button
                          onClick={() => handleRecharge(r.id, 'rejected')}
                          disabled={processing === r.id}
                          className="px-3 py-1 rounded-lg text-xs font-medium bg-red-100 text-red-700 hover:bg-red-200 disabled:opacity-50"
                        >
                          {t('common.reject')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap">{t('wallet_admin.col_description')}</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap">{t('wallet_admin.col_type')}</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap hidden lg:table-cell">{t('wallet_admin.col_ref')}</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-500 whitespace-nowrap hidden lg:table-cell">{t('wallet_admin.col_date')}</th>
              </tr>
            </thead>
            <tbody>
              {transactions.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-12 text-neutral-400">
                    {loading ? t('common.loading') : t('wallet_admin.no_ledger')}
                  </td>
                </tr>
              ) : (
                transactions.map((tx) => (
                  <tr key={tx.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                    <td className="px-4 py-3 text-neutral-900">{tx.description}</td>
                    <td className="px-4 py-3">
                      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-700">
                        {tx.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-neutral-500 text-xs font-mono hidden lg:table-cell">
                      {tx.reference_id ? tx.reference_id.slice(0, 8) : '—'}
                    </td>
                    <td className="px-4 py-3 text-neutral-500 hidden lg:table-cell">
                      {new Date(tx.created_at).toLocaleDateString('es-CU', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
        </div>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4">
        <button
          onClick={() => setPage((p) => p - 1)}
          disabled={!canGoPrev}
          className="px-4 py-2 rounded-lg text-sm border border-neutral-200 disabled:opacity-30"
        >
          {t('common.previous')}
        </button>
        <span className="text-sm text-neutral-500">
          {t('common.page')} <strong>{page + 1}</strong>
        </span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={!canGoNext}
          className="px-4 py-2 rounded-lg text-sm border border-neutral-200 disabled:opacity-30"
        >
          {t('common.next')}
        </button>
      </div>
    </div>
  );
}
