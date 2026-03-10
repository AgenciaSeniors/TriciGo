'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { Promotion } from '@tricigo/types';
import type { PromotionType } from '@tricigo/types';
import { useAdminUser } from '@/lib/useAdminUser';

const PAGE_SIZE = 20;

const STATUS_TAB_KEYS = [
  { labelKey: 'promotions.filter_all', value: 'all' },
  { labelKey: 'promotions.filter_active', value: 'active' },
  { labelKey: 'promotions.filter_inactive', value: 'inactive' },
] as const;

const TYPE_LABEL_KEY: Record<string, string> = {
  percentage_discount: 'promotions.type_percentage',
  fixed_discount: 'promotions.type_fixed',
  bonus_credit: 'promotions.type_bonus',
};

type CreateForm = {
  code: string;
  type: PromotionType;
  discount_percent: string;
  discount_fixed_cup: string;
  max_uses: string;
  valid_from: string;
  valid_until: string;
};

const emptyForm: CreateForm = {
  code: '',
  type: 'percentage_discount',
  discount_percent: '',
  discount_fixed_cup: '',
  max_uses: '',
  valid_from: new Date().toISOString().slice(0, 16),
  valid_until: '',
};

export default function PromotionsPage() {
  const { t } = useTranslation('admin');
  const { userId: adminUserId } = useAdminUser();
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    async function fetch() {
      try {
        const data = await adminService.getPromotions(page, PAGE_SIZE);
        if (!cancelled) setPromotions(data);
      } catch (err) {
        console.error('Error fetching promotions:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch();
    return () => { cancelled = true; };
  }, [page]);

  const filtered = filter === 'all'
    ? promotions
    : filter === 'active'
      ? promotions.filter((p) => p.is_active)
      : promotions.filter((p) => !p.is_active);

  async function handleCreate() {
    if (!form.code.trim()) return;
    setSaving(true);
    try {
      const payload: Parameters<typeof adminService.createPromotion>[0] = {
        code: form.code.trim().toUpperCase(),
        type: form.type,
        is_active: true,
        valid_from: new Date(form.valid_from).toISOString(),
      };
      if (form.type === 'percentage_discount' && form.discount_percent) {
        payload.discount_percent = parseFloat(form.discount_percent);
      }
      if ((form.type === 'fixed_discount' || form.type === 'bonus_credit') && form.discount_fixed_cup) {
        payload.discount_fixed_cup = Math.round(parseFloat(form.discount_fixed_cup) * 100);
      }
      if (form.max_uses) {
        payload.max_uses = parseInt(form.max_uses);
      }
      if (form.valid_until) {
        payload.valid_until = new Date(form.valid_until).toISOString();
      }
      await adminService.createPromotion(payload, adminUserId);
      const data = await adminService.getPromotions(page, PAGE_SIZE);
      setPromotions(data);
      setForm(emptyForm);
      setShowCreate(false);
    } catch (err) {
      console.error('Error creating promotion:', err);
      window.alert(t('promotions.error_creating'));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(promo: Promotion) {
    try {
      await adminService.updatePromotion(promo.id, { is_active: !promo.is_active });
      setPromotions((prev) => prev.map((p) => p.id === promo.id ? { ...p, is_active: !p.is_active } : p));
    } catch (err) {
      console.error('Error toggling:', err);
    }
  }

  async function handleDelete(promo: Promotion) {
    if (promo.current_uses > 0) return;
    if (!window.confirm(t('promotions.confirm_delete', { code: promo.code }))) return;
    try {
      await adminService.deletePromotion(promo.id);
      setPromotions((prev) => prev.filter((p) => p.id !== promo.id));
    } catch (err) {
      console.error('Error deleting:', err);
      window.alert(t('promotions.error_deleting'));
    }
  }

  function formatDiscount(p: Promotion) {
    if (p.type === 'percentage_discount' && p.discount_percent != null) {
      return `${p.discount_percent}%`;
    }
    if (p.discount_fixed_cup != null) {
      return formatCUP(p.discount_fixed_cup);
    }
    return '—';
  }

  const canGoPrev = page > 0;
  const canGoNext = promotions.length === PAGE_SIZE;

  return (
    <div>
      <Link href="/settings" className="text-sm text-[#FF4D00] hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">{t('promotions.title')}</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-[#FF4D00] text-white hover:bg-[#E64500]"
        >
          {t('promotions.create_promotion')}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="bg-white rounded-xl p-6 shadow-sm border border-neutral-100 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('promotions.label_code')}</label>
              <input
                className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm uppercase"
                placeholder="PROMO2024"
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('promotions.label_type')}</label>
              <select
                className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as PromotionType }))}
              >
                <option value="percentage_discount">{t('promotions.option_percentage')}</option>
                <option value="fixed_discount">{t('promotions.option_fixed')}</option>
                <option value="bonus_credit">{t('promotions.option_bonus')}</option>
              </select>
            </div>
            <div>
              {form.type === 'percentage_discount' ? (
                <>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">{t('promotions.label_discount_percent')}</label>
                  <input
                    type="number"
                    className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                    placeholder="10"
                    value={form.discount_percent}
                    onChange={(e) => setForm((f) => ({ ...f, discount_percent: e.target.value }))}
                    min="1"
                    max="100"
                  />
                </>
              ) : (
                <>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">{t('promotions.label_amount')}</label>
                  <input
                    type="number"
                    className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                    placeholder="50.00"
                    value={form.discount_fixed_cup}
                    onChange={(e) => setForm((f) => ({ ...f, discount_fixed_cup: e.target.value }))}
                    step="0.01"
                  />
                </>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('promotions.label_max_uses')}</label>
              <input
                type="number"
                className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                placeholder={t('promotions.unlimited_placeholder')}
                value={form.max_uses}
                onChange={(e) => setForm((f) => ({ ...f, max_uses: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('promotions.label_valid_from')}</label>
              <input
                type="datetime-local"
                className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                value={form.valid_from}
                onChange={(e) => setForm((f) => ({ ...f, valid_from: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">{t('promotions.label_valid_until')}</label>
              <input
                type="datetime-local"
                className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                value={form.valid_until}
                onChange={(e) => setForm((f) => ({ ...f, valid_until: e.target.value }))}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={saving || !form.code.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-[#FF4D00] text-white hover:bg-[#E64500] disabled:opacity-50"
            >
              {t('common.create')}
            </button>
            <button
              onClick={() => { setShowCreate(false); setForm(emptyForm); }}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {STATUS_TAB_KEYS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
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

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-100">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('promotions.col_code')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('promotions.col_type')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('promotions.col_discount')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('promotions.col_uses')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('promotions.col_valid_until')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('promotions.col_active')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-neutral-400">
                  {loading ? t('common.loading') : t('promotions.no_promotions')}
                </td>
              </tr>
            ) : (
              filtered.map((p) => (
                <tr key={p.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                  <td className="px-4 py-3 font-mono font-medium">{p.code}</td>
                  <td className="px-4 py-3">
                    <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-700">
                      {TYPE_LABEL_KEY[p.type] ? t(TYPE_LABEL_KEY[p.type]!) : p.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium">{formatDiscount(p)}</td>
                  <td className="px-4 py-3 text-neutral-500">
                    {p.current_uses} / {p.max_uses ?? '∞'}
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {p.valid_until
                      ? new Date(p.valid_until).toLocaleDateString('es-CU', { day: 'numeric', month: 'short', year: 'numeric' })
                      : t('promotions.no_limit')}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleActive(p)}
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        p.is_active ? 'bg-green-100 text-green-700' : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {p.is_active ? t('promotions.active_label') : t('promotions.inactive_label')}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    {p.current_uses === 0 && (
                      <button
                        onClick={() => handleDelete(p)}
                        className="text-sm text-red-500 hover:underline"
                      >
                        {t('common.delete')}
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
