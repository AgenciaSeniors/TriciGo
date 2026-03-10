'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { PricingRule, Zone } from '@tricigo/types';

const PAGE_SIZE = 20;

const SERVICE_TAB_KEYS = [
  { labelKey: 'pricing.filter_all', value: 'all' },
  { labelKey: 'pricing.filter_triciclo', value: 'triciclo_basico' },
  { labelKey: 'pricing.filter_moto', value: 'moto_standard' },
  { labelKey: 'pricing.filter_auto', value: 'auto_standard' },
] as const;

type ZoneRow = Omit<Zone, 'boundary'>;

export default function PricingPage() {
  const { t } = useTranslation('admin');
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<PricingRule>>({});
  const [saving, setSaving] = useState(false);

  // Fetch zones once for name mapping
  useEffect(() => {
    adminService.getZones().then(setZones).catch(console.error);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    async function fetch() {
      try {
        const data = await adminService.getPricingRules(page, PAGE_SIZE);
        if (!cancelled) setRules(data);
      } catch (err) {
        console.error('Error fetching pricing rules:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch();
    return () => { cancelled = true; };
  }, [page]);

  const zoneMap = new Map(zones.map((z) => [z.id, z.name]));
  const filtered = filter === 'all' ? rules : rules.filter((r) => r.service_type === filter);

  function startEdit(rule: PricingRule) {
    setEditingId(rule.id);
    setEditForm({
      base_fare_cup: rule.base_fare_cup,
      per_km_rate_cup: rule.per_km_rate_cup,
      per_minute_rate_cup: rule.per_minute_rate_cup,
      min_fare_cup: rule.min_fare_cup,
      surge_threshold: rule.surge_threshold,
      max_surge_multiplier: rule.max_surge_multiplier,
    });
  }

  async function handleSave() {
    if (!editingId) return;
    setSaving(true);
    try {
      await adminService.updatePricingRule(editingId, editForm);
      const data = await adminService.getPricingRules(page, PAGE_SIZE);
      setRules(data);
      setEditingId(null);
    } catch (err) {
      console.error('Error updating pricing rule:', err);
      window.alert('Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(rule: PricingRule) {
    try {
      await adminService.updatePricingRule(rule.id, { is_active: !rule.is_active });
      setRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, is_active: !r.is_active } : r));
    } catch (err) {
      console.error('Error toggling:', err);
    }
  }

  function cupInput(field: keyof PricingRule) {
    return (
      <input
        type="number"
        className="w-20 px-2 py-1 border border-neutral-300 rounded text-sm"
        value={((editForm[field] as number) ?? 0) / 100}
        onChange={(e) => setEditForm((f) => ({ ...f, [field]: Math.round(parseFloat(e.target.value || '0') * 100) }))}
        step="0.01"
      />
    );
  }

  function numInput(field: keyof PricingRule, step = '0.1') {
    return (
      <input
        type="number"
        className="w-16 px-2 py-1 border border-neutral-300 rounded text-sm"
        value={(editForm[field] as number) ?? ''}
        onChange={(e) => setEditForm((f) => ({ ...f, [field]: e.target.value ? parseFloat(e.target.value) : null }))}
        step={step}
      />
    );
  }

  const canGoPrev = page > 0;
  const canGoNext = rules.length === PAGE_SIZE;

  return (
    <div>
      <Link href="/settings" className="text-sm text-[#FF4D00] hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>
      <h1 className="text-3xl font-bold mb-6">{t('pricing.title')}</h1>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {SERVICE_TAB_KEYS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => { setFilter(tab.value); setPage(0); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === tab.value
                ? 'bg-[#FF4D00] text-white'
                : 'bg-white text-neutral-600 border border-neutral-200 hover:border-neutral-300'
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-100">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_zone')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_service')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_base')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_per_km')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_per_min')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_min')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_surge')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_active')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-center py-12 text-neutral-400">
                  {loading ? t('common.loading') : t('pricing.no_rules')}
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                  <td className="px-4 py-3 text-neutral-500">
                    {r.zone_id ? (zoneMap.get(r.zone_id) ?? t('pricing.zone_label')) : t('pricing.global_zone')}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{r.service_type}</td>
                  <td className="px-4 py-3">
                    {editingId === r.id ? cupInput('base_fare_cup') : formatCUP(r.base_fare_cup)}
                  </td>
                  <td className="px-4 py-3">
                    {editingId === r.id ? cupInput('per_km_rate_cup') : formatCUP(r.per_km_rate_cup)}
                  </td>
                  <td className="px-4 py-3">
                    {editingId === r.id ? cupInput('per_minute_rate_cup') : formatCUP(r.per_minute_rate_cup)}
                  </td>
                  <td className="px-4 py-3">
                    {editingId === r.id ? cupInput('min_fare_cup') : formatCUP(r.min_fare_cup)}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {editingId === r.id ? (
                      <div className="flex gap-1 items-center">
                        {numInput('max_surge_multiplier', '0.1')}
                        <span>x</span>
                      </div>
                    ) : (
                      r.max_surge_multiplier ? `${r.max_surge_multiplier}x` : '—'
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleActive(r)}
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        r.is_active ? 'bg-green-100 text-green-700' : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {r.is_active ? t('common.active') : t('common.inactive')}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    {editingId === r.id ? (
                      <div className="flex gap-2">
                        <button
                          onClick={handleSave}
                          disabled={saving}
                          className="px-3 py-1 rounded-lg text-xs font-medium bg-[#FF4D00] text-white hover:bg-[#E64500] disabled:opacity-50"
                        >
                          {t('common.save')}
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="px-3 py-1 rounded-lg text-xs font-medium bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                        >
                          {t('common.cancel')}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startEdit(r)}
                        className="text-sm text-[#FF4D00] hover:underline"
                      >
                        {t('common.edit')}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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
