'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { corporateService } from '@tricigo/api';
import { formatTriciCoin } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { CorporateAccount, CorporateAccountStatus } from '@tricigo/types';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { formatAdminDate } from '@/lib/formatDate';

const PAGE_SIZE = 20;

type Tab = 'all' | CorporateAccountStatus;

const statusClasses: Record<CorporateAccountStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  suspended: 'bg-red-100 text-red-800',
  rejected: 'bg-neutral-200 text-neutral-600',
};

export default function BusinessesPage() {
  const { t } = useTranslation('admin');
  const [tab, setTab] = useState<Tab>('all');
  const [accounts, setAccounts] = useState<CorporateAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    corporateService
      .listAccounts(tab === 'all' ? undefined : tab, page, PAGE_SIZE)
      .then((data) => {
        if (!cancelled) setAccounts(data);
      })
      .catch(() => { /* Error handled silently */ })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [tab, page]);

  const tabs: Tab[] = ['all', 'pending', 'approved', 'suspended', 'rejected'];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t('businesses.title')}</h1>

      {/* Tabs */}
      <div className="flex gap-2 flex-wrap">
        {tabs.map((tb) => (
          <button
            key={tb}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === tb
                ? 'bg-primary-500 text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
            aria-pressed={tab === tb}
            aria-label={t(`businesses.filter_${tb}`)}
            onClick={() => { setTab(tb); setPage(0); }}
          >
            {t(`businesses.filter_${tb}`)}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <AdminTableSkeleton rows={5} columns={4} />
      ) : accounts.length === 0 ? (
        <div className="text-center py-12 text-neutral-500">
          {t('businesses.no_businesses')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-neutral-500">
                <th className="pb-3 pr-4">{t('businesses.col_name')}</th>
                <th className="pb-3 pr-4">{t('businesses.col_contact')}</th>
                <th className="pb-3 pr-4">{t('businesses.col_status')}</th>
                <th className="pb-3 pr-4">{t('businesses.col_spent')}</th>
                <th className="pb-3">{t('common.created_at', { defaultValue: 'Creado' })}</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((acc) => (
                <tr key={acc.id} className="border-b hover:bg-neutral-50 transition-colors">
                  <td className="py-3 pr-4">
                    <Link
                      href={`/businesses/${acc.id}`}
                      className="text-primary-600 hover:underline font-medium"
                    >
                      {acc.name}
                    </Link>
                  </td>
                  <td className="py-3 pr-4 text-neutral-600">{acc.contact_phone}</td>
                  <td className="py-3 pr-4">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusClasses[acc.status]}`}>
                      {t(`businesses.filter_${acc.status}`)}
                    </span>
                  </td>
                  <td className="py-3 pr-4 font-mono">
                    {formatTriciCoin(acc.current_month_spent)}
                    {acc.monthly_budget_trc > 0 && (
                      <span className="text-neutral-400"> / {formatTriciCoin(acc.monthly_budget_trc)}</span>
                    )}
                  </td>
                  <td className="py-3 text-neutral-500">
                    {formatAdminDate(acc.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="flex justify-between items-center">
        <button
          className="px-4 py-2 text-sm bg-neutral-100 rounded-lg disabled:opacity-50"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
          aria-label={t('common.previous', { defaultValue: 'Anterior' })}
        >
          {t('common.previous', { defaultValue: 'Anterior' })}
        </button>
        <span className="text-sm text-neutral-500" aria-live="polite">
          {t('common.page', { defaultValue: 'Página' })} {page + 1}
        </span>
        <button
          className="px-4 py-2 text-sm bg-neutral-100 rounded-lg disabled:opacity-50"
          disabled={accounts.length < PAGE_SIZE}
          onClick={() => setPage(page + 1)}
          aria-label={t('common.next', { defaultValue: 'Siguiente' })}
        >
          {t('common.next', { defaultValue: 'Siguiente' })}
        </button>
      </div>
    </div>
  );
}
