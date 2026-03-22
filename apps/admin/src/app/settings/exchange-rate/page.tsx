'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import type { ExchangeRate } from '@tricigo/types';

export default function ExchangeRatePage() {
  const { t } = useTranslation('admin');
  const [currentRate, setCurrentRate] = useState<ExchangeRate | null>(null);
  const [history, setHistory] = useState<ExchangeRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [manualRate, setManualRate] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [rate, hist] = await Promise.all([
          adminService.getExchangeRate(),
          adminService.getExchangeRateHistory(30),
        ]);
        if (!cancelled) {
          setCurrentRate(rate);
          setHistory(hist);
        }
      } catch (err) {
        // Error handled by UI
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  async function handleSetManualRate() {
    const rate = Number(manualRate);
    if (!rate || rate <= 0) {
      setError(t('exchange_rate.error_invalid_rate'));
      return;
    }

    setSaving(true);
    setError(null);
    setSavedMsg(false);

    try {
      await adminService.setManualExchangeRate(rate);
      // Refresh data
      const [newRate, newHist] = await Promise.all([
        adminService.getExchangeRate(),
        adminService.getExchangeRateHistory(30),
      ]);
      setCurrentRate(newRate);
      setHistory(newHist);
      setManualRate('');
      setSavedMsg(true);
      setTimeout(() => setSavedMsg(false), 3000);
    } catch {
      setError(t('exchange_rate.error_saving'));
    } finally {
      setSaving(false);
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString('es-CU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return (
    <div>
      <Link href="/settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>
      <h1 className="text-3xl font-bold mb-2">{t('exchange_rate.title')}</h1>
      <p className="text-neutral-500 mb-6">{t('exchange_rate.subtitle')}</p>

      {loading ? (
        <p className="text-neutral-400">{t('common.loading')}</p>
      ) : (
        <>
          {/* Current Rate Card */}
          <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 mb-6">
            <h2 className="text-lg font-bold mb-4">{t('exchange_rate.current_rate')}</h2>
            {currentRate ? (
              <div className="flex items-center gap-6">
                <div className="text-4xl font-bold text-primary-600">
                  {Number(currentRate.usd_cup_rate).toLocaleString('es-CU')} CUP
                </div>
                <div className="text-neutral-500">
                  <p className="text-sm">1 USD = {Number(currentRate.usd_cup_rate).toLocaleString('es-CU')} CUP</p>
                  <p className="text-sm">1 TRC = {Number(currentRate.usd_cup_rate).toLocaleString('es-CU')} CUP</p>
                  <p className="text-xs text-neutral-400 mt-1">
                    {t('exchange_rate.source')}: {currentRate.source === 'eltoque_api' ? 'ElToque API' : t('exchange_rate.manual')}
                  </p>
                  <p className="text-xs text-neutral-400">
                    {t('exchange_rate.updated_at')}: {formatDate(currentRate.fetched_at)}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-neutral-400">{t('exchange_rate.no_rate')}</p>
            )}
          </div>

          {/* Manual Override */}
          <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 mb-6">
            <h2 className="text-lg font-bold mb-4">{t('exchange_rate.manual_override')}</h2>
            <p className="text-sm text-neutral-500 mb-4">{t('exchange_rate.manual_override_desc')}</p>
            <div className="flex items-center gap-3">
              <span className="text-sm text-neutral-600 whitespace-nowrap">1 USD =</span>
              <input
                type="number"
                step="1"
                min="1"
                className="w-32 px-3 py-2 border border-neutral-300 rounded-lg text-sm text-right font-mono"
                placeholder="520"
                value={manualRate}
                onChange={(e) => setManualRate(e.target.value)}
              />
              <span className="text-sm text-neutral-600">CUP</span>
              <button
                onClick={handleSetManualRate}
                disabled={saving || !manualRate}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {saving ? t('common.saving') : t('exchange_rate.set_rate')}
              </button>
            </div>
            {savedMsg && (
              <p className="text-sm text-green-600 mt-2 flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                {t('exchange_rate.rate_saved')}
              </p>
            )}
            {error && (
              <p className="text-sm text-red-600 mt-2">{error}</p>
            )}
          </div>

          {/* Rate History */}
          <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100">
            <h2 className="text-lg font-bold mb-4">{t('exchange_rate.history')}</h2>
            {history.length === 0 ? (
              <p className="text-neutral-400 text-center py-4">{t('exchange_rate.no_history')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-left">
                      <th className="py-2 px-3 font-medium text-neutral-600">{t('exchange_rate.col_date')}</th>
                      <th className="py-2 px-3 font-medium text-neutral-600">{t('exchange_rate.col_rate')}</th>
                      <th className="py-2 px-3 font-medium text-neutral-600">{t('exchange_rate.col_source')}</th>
                      <th className="py-2 px-3 font-medium text-neutral-600">{t('exchange_rate.col_status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((rate) => (
                      <tr key={rate.id} className="border-b border-neutral-100 hover:bg-neutral-50">
                        <td className="py-2 px-3 text-neutral-700">{formatDate(rate.fetched_at)}</td>
                        <td className="py-2 px-3 font-mono font-medium">
                          {Number(rate.usd_cup_rate).toLocaleString('es-CU')} CUP
                        </td>
                        <td className="py-2 px-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            rate.source === 'eltoque_api'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}>
                            {rate.source === 'eltoque_api' ? 'ElToque' : t('exchange_rate.manual')}
                          </span>
                        </td>
                        <td className="py-2 px-3">
                          {rate.is_current && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                              {t('exchange_rate.active')}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
