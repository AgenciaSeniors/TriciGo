'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { PricingRule, Zone, ServiceTypeSlug } from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';

const PAGE_SIZE = 20;

const SERVICE_TAB_KEYS = [
  { labelKey: 'pricing.filter_all', value: 'all' },
  { labelKey: 'pricing.filter_triciclo', value: 'triciclo_basico' },
  { labelKey: 'pricing.filter_moto', value: 'moto_standard' },
  { labelKey: 'pricing.filter_auto', value: 'auto_standard' },
  { labelKey: 'pricing.filter_confort', value: 'auto_confort' },
  { labelKey: 'pricing.filter_mensajeria', value: 'mensajeria' },
] as const;

const SERVICE_OPTIONS = [
  'triciclo_basico',
  'moto_standard',
  'auto_standard',
  'auto_confort',
  'mensajeria',
];

const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];

type ZoneRow = Omit<Zone, 'boundary'>;

function getTimeBand(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return null;
  const s = start.substring(0, 5);
  if (s === '06:00') return 'morning';
  if (s === '12:00') return 'afternoon';
  if (s === '18:00') return 'night';
  if (s === '00:00') return 'dawn';
  return null;
}

function TimeBandBadge({ start, end, t }: { start: string | null | undefined; end: string | null | undefined; t: (key: string, opts?: Record<string, string>) => string }) {
  const band = getTimeBand(start, end);
  if (!band) {
    if (!start && !end) return <span className="text-neutral-400 text-xs">{t('pricing.time_band_24h')}</span>;
    return <span className="text-xs">{start} - {end}</span>;
  }
  const configs: Record<string, { emoji: string; label: string; color: string }> = {
    morning: { emoji: '\u{1F305}', label: t('pricing.time_band_morning'), color: 'bg-amber-100 text-amber-700' },
    afternoon: { emoji: '\u{2600}\u{FE0F}', label: t('pricing.time_band_afternoon'), color: 'bg-yellow-100 text-yellow-700' },
    night: { emoji: '\u{1F319}', label: t('pricing.time_band_night'), color: 'bg-indigo-100 text-indigo-700' },
    dawn: { emoji: '\u{1F311}', label: t('pricing.time_band_dawn'), color: 'bg-purple-100 text-purple-700' },
  };
  const c = configs[band]!;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${c.color}`}>
      {c.emoji} {c.label}
    </span>
  );
}

// Pricing matrix component
function PricingMatrix({ rules, t }: { rules: PricingRule[]; t: (key: string) => string }) {
  const serviceTypes = ['triciclo_basico', 'moto_standard', 'auto_standard'];
  const serviceLabels: Record<string, string> = {
    triciclo_basico: 'Triciclo',
    moto_standard: 'Moto',
    auto_standard: 'Auto',
  };
  const bands = [
    { key: 'morning', label: t('pricing.time_band_morning'), emoji: '\u{1F305}', start: '06:00' },
    { key: 'afternoon', label: t('pricing.time_band_afternoon'), emoji: '\u{2600}\u{FE0F}', start: '12:00' },
    { key: 'night', label: t('pricing.time_band_night'), emoji: '\u{1F319}', start: '18:00' },
    { key: 'dawn', label: t('pricing.time_band_dawn'), emoji: '\u{1F311}', start: '00:00' },
  ];

  return (
    <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-4 mb-6">
      <h3 className="text-sm font-semibold text-neutral-700 mb-3">{t('pricing.pricing_matrix')}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-neutral-100">
              <th className="text-left py-2 px-2 font-medium text-neutral-500">Servicio</th>
              {bands.map((b) => (
                <th key={b.key} className="text-center py-2 px-2 font-medium text-neutral-500">
                  {b.emoji} {b.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {serviceTypes.map((svc) => (
              <tr key={svc} className="border-b border-neutral-50">
                <td className="py-2 px-2 font-semibold text-neutral-700">{serviceLabels[svc]}</td>
                {bands.map((b) => {
                  const rule = rules.find(
                    (r) =>
                      r.service_type === svc &&
                      r.time_window_start &&
                      r.time_window_start.substring(0, 5) === b.start,
                  );
                  if (!rule) return <td key={b.key} className="text-center py-2 px-2 text-neutral-300">—</td>;
                  return (
                    <td key={b.key} className="text-center py-2 px-2">
                      <div className="font-mono font-semibold">{formatCUP(rule.base_fare_cup)}</div>
                      <div className="text-neutral-400">{formatCUP(rule.per_km_rate_cup)}/km</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PricingPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<PricingRule>>({});
  const [saving, setSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    service_type: 'triciclo_basico',
    zone_id: '' as string,
    base_fare_cup: 0,
    per_km_rate_cup: 0,
    per_minute_rate_cup: 0,
    min_fare_cup: 0,
    time_window_start: '',
    time_window_end: '',
    day_of_week: [] as number[],
  });
  const [creating, setCreating] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  function validatePricingForm() {
    const errors: Record<string, string> = {};
    if (!createForm.service_type) errors.service_type = 'Campo requerido';
    if (createForm.base_fare_cup < 0) errors.base_fare_cup = 'Debe ser positivo';
    if (createForm.per_km_rate_cup < 0) errors.per_km_rate_cup = 'Debe ser positivo';
    if (createForm.per_minute_rate_cup < 0) errors.per_minute_rate_cup = 'Debe ser positivo';
    if (createForm.min_fare_cup < 0) errors.min_fare_cup = 'Debe ser positivo';
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  // Fetch zones once for name mapping
  useEffect(() => {
    adminService.getZones().then(setZones).catch(console.error);
  }, []);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminService.getPricingRules(page, PAGE_SIZE);
      setRules(data);
    } catch (err) {
      console.error('Error fetching pricing rules:', err);
      setError(err instanceof Error ? err.message : 'Error al cargar reglas de precios');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

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
      time_window_start: rule.time_window_start,
      time_window_end: rule.time_window_end,
      day_of_week: rule.day_of_week,
    });
  }

  async function handleSave() {
    if (!editingId) return;
    setSaving(true);
    try {
      await adminService.updatePricingRule(editingId, editForm);
      await fetchRules();
      setEditingId(null);
    } catch (err) {
      console.error('Error updating pricing rule:', err);
      showToast('error', 'Error al guardar');
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

  async function handleDelete(rule: PricingRule) {
    if (!window.confirm(t('pricing.confirm_delete'))) return;
    try {
      await adminService.deletePricingRule(rule.id);
      await fetchRules();
    } catch (err) {
      console.error('Error deleting:', err);
      showToast('error', t('pricing.error_deleting'));
    }
  }

  async function handleCreate() {
    if (!validatePricingForm()) return;
    setCreating(true);
    try {
      await adminService.createPricingRule({
        service_type: createForm.service_type as ServiceTypeSlug,
        zone_id: createForm.zone_id || null,
        base_fare_cup: createForm.base_fare_cup,
        per_km_rate_cup: createForm.per_km_rate_cup,
        per_minute_rate_cup: createForm.per_minute_rate_cup,
        min_fare_cup: createForm.min_fare_cup,
        time_window_start: createForm.time_window_start || null,
        time_window_end: createForm.time_window_end || null,
        day_of_week: createForm.day_of_week.length > 0 ? createForm.day_of_week : null,
        is_active: true,
      });
      await fetchRules();
      setShowCreate(false);
      setFormErrors({});
      setCreateForm({
        service_type: 'triciclo_basico',
        zone_id: '',
        base_fare_cup: 0,
        per_km_rate_cup: 0,
        per_minute_rate_cup: 0,
        min_fare_cup: 0,
        time_window_start: '',
        time_window_end: '',
        day_of_week: [],
      });
    } catch (err) {
      console.error('Error creating:', err);
      showToast('error', t('pricing.error_creating'));
    } finally {
      setCreating(false);
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
      <Link href="/settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>
      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); fetchRules(); }}
          onDismiss={() => setError(null)}
        />
      )}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">{t('pricing.title')}</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors"
        >
          + {t('pricing.create_rule')}
        </button>
      </div>

      {/* Pricing Matrix */}
      <PricingMatrix rules={rules} t={t} />

      {/* Create form */}
      {showCreate && (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-6">
          <h3 className="text-lg font-semibold mb-4">{t('pricing.new_rule_title')}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-600 mb-1">{t('pricing.label_service_type')}<span className="text-red-500 ml-1">*</span></label>
              <select
                className={`w-full px-3 py-2 border rounded-lg text-sm ${formErrors.service_type ? 'border-red-500' : 'border-neutral-300'}`}
                value={createForm.service_type}
                onChange={(e) => { setCreateForm((f) => ({ ...f, service_type: e.target.value })); setFormErrors((prev) => { const { service_type, ...rest } = prev; return rest; }); }}
              >
                {SERVICE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-600 mb-1">{t('pricing.label_zone')}</label>
              <select
                className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                value={createForm.zone_id}
                onChange={(e) => setCreateForm((f) => ({ ...f, zone_id: e.target.value }))}
              >
                <option value="">Global</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>{z.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-600 mb-1">{t('pricing.label_base_fare')}<span className="text-red-500 ml-1">*</span></label>
              <input
                type="number"
                className={`w-full px-3 py-2 border rounded-lg text-sm ${formErrors.base_fare_cup ? 'border-red-500' : 'border-neutral-300'}`}
                value={createForm.base_fare_cup / 100 || ''}
                onChange={(e) => { setCreateForm((f) => ({ ...f, base_fare_cup: Math.round(parseFloat(e.target.value || '0') * 100) })); setFormErrors((prev) => { const { base_fare_cup, ...rest } = prev; return rest; }); }}
                step="0.01"
              />
              {formErrors.base_fare_cup && <p className="text-red-500 text-xs mt-1">{formErrors.base_fare_cup}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-600 mb-1">{t('pricing.label_per_km')}<span className="text-red-500 ml-1">*</span></label>
              <input
                type="number"
                className={`w-full px-3 py-2 border rounded-lg text-sm ${formErrors.per_km_rate_cup ? 'border-red-500' : 'border-neutral-300'}`}
                value={createForm.per_km_rate_cup / 100 || ''}
                onChange={(e) => { setCreateForm((f) => ({ ...f, per_km_rate_cup: Math.round(parseFloat(e.target.value || '0') * 100) })); setFormErrors((prev) => { const { per_km_rate_cup, ...rest } = prev; return rest; }); }}
                step="0.01"
              />
              {formErrors.per_km_rate_cup && <p className="text-red-500 text-xs mt-1">{formErrors.per_km_rate_cup}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-600 mb-1">{t('pricing.label_per_min')}<span className="text-red-500 ml-1">*</span></label>
              <input
                type="number"
                className={`w-full px-3 py-2 border rounded-lg text-sm ${formErrors.per_minute_rate_cup ? 'border-red-500' : 'border-neutral-300'}`}
                value={createForm.per_minute_rate_cup / 100 || ''}
                onChange={(e) => { setCreateForm((f) => ({ ...f, per_minute_rate_cup: Math.round(parseFloat(e.target.value || '0') * 100) })); setFormErrors((prev) => { const { per_minute_rate_cup, ...rest } = prev; return rest; }); }}
                step="0.01"
              />
              {formErrors.per_minute_rate_cup && <p className="text-red-500 text-xs mt-1">{formErrors.per_minute_rate_cup}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-600 mb-1">{t('pricing.label_min_fare')}<span className="text-red-500 ml-1">*</span></label>
              <input
                type="number"
                className={`w-full px-3 py-2 border rounded-lg text-sm ${formErrors.min_fare_cup ? 'border-red-500' : 'border-neutral-300'}`}
                value={createForm.min_fare_cup / 100 || ''}
                onChange={(e) => { setCreateForm((f) => ({ ...f, min_fare_cup: Math.round(parseFloat(e.target.value || '0') * 100) })); setFormErrors((prev) => { const { min_fare_cup, ...rest } = prev; return rest; }); }}
                step="0.01"
              />
              {formErrors.min_fare_cup && <p className="text-red-500 text-xs mt-1">{formErrors.min_fare_cup}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-600 mb-1">{t('pricing.label_time_start')}</label>
              <input
                type="time"
                className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                value={createForm.time_window_start}
                onChange={(e) => setCreateForm((f) => ({ ...f, time_window_start: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-600 mb-1">{t('pricing.label_time_end')}</label>
              <input
                type="time"
                className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm"
                value={createForm.time_window_end}
                onChange={(e) => setCreateForm((f) => ({ ...f, time_window_end: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-600 mb-1">{t('pricing.label_days')}</label>
              <div className="flex gap-1 flex-wrap mt-1">
                {DAY_LABELS.map((label, idx) => {
                  const selected = createForm.day_of_week.includes(idx);
                  return (
                    <button
                      key={idx}
                      type="button"
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        selected ? 'bg-primary-500 text-white' : 'bg-neutral-100 text-neutral-500'
                      }`}
                      onClick={() => {
                        const next = selected
                          ? createForm.day_of_week.filter((d) => d !== idx)
                          : [...createForm.day_of_week, idx];
                        setCreateForm((f) => ({ ...f, day_of_week: next }));
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <button
              onClick={handleCreate}
              disabled={creating || !createForm.service_type}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50"
            >
              {creating ? t('pricing.creating') : t('common.create')}
            </button>
            <button
              onClick={() => { setShowCreate(false); setFormErrors({}); }}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {SERVICE_TAB_KEYS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => { setFilter(tab.value); setPage(0); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === tab.value
                ? 'bg-primary-500 text-white'
                : 'bg-white text-neutral-600 border border-neutral-200 hover:border-neutral-300'
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-neutral-50 border-b border-neutral-100">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_zone')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_service')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_base')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_per_km')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_per_min')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_min')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_surge')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_time_window')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('pricing.col_active')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={10} className="text-center py-12 text-neutral-400">
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
                      r.max_surge_multiplier ? `${r.max_surge_multiplier}x` : '\u2014'
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {editingId === r.id ? (
                      <div className="space-y-1">
                        <div className="flex gap-1 items-center">
                          <input
                            type="time"
                            className="w-24 px-1 py-0.5 border border-neutral-300 rounded text-xs"
                            value={editForm.time_window_start ?? ''}
                            onChange={(e) => setEditForm((f) => ({ ...f, time_window_start: e.target.value || null }))}
                          />
                          <span>-</span>
                          <input
                            type="time"
                            className="w-24 px-1 py-0.5 border border-neutral-300 rounded text-xs"
                            value={editForm.time_window_end ?? ''}
                            onChange={(e) => setEditForm((f) => ({ ...f, time_window_end: e.target.value || null }))}
                          />
                        </div>
                        <div className="flex gap-0.5 flex-wrap">
                          {DAY_LABELS.map((label, idx) => {
                            const selected = editForm.day_of_week?.includes(idx);
                            return (
                              <button
                                key={idx}
                                type="button"
                                className={`px-1 py-0.5 rounded text-[10px] ${
                                  selected ? 'bg-primary-500 text-white' : 'bg-neutral-100 text-neutral-500'
                                }`}
                                onClick={() => {
                                  const current = editForm.day_of_week ?? [];
                                  const next = selected ? current.filter((d) => d !== idx) : [...current, idx];
                                  setEditForm((f) => ({ ...f, day_of_week: next.length > 0 ? next : null }));
                                }}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div>
                        <TimeBandBadge start={r.time_window_start} end={r.time_window_end} t={t} />
                        {r.day_of_week && r.day_of_week.length > 0 && (
                          <div className="text-neutral-400 mt-0.5 text-[10px]">
                            {r.day_of_week.map((d) => DAY_LABELS[d]).join(', ')}
                          </div>
                        )}
                      </div>
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
                          className="px-3 py-1 rounded-lg text-xs font-medium bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50"
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
                      <div className="flex gap-2">
                        <button
                          onClick={() => startEdit(r)}
                          className="text-sm text-primary-500 hover:underline"
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          onClick={() => handleDelete(r)}
                          className="text-sm text-red-500 hover:underline"
                        >
                          {t('pricing.delete_rule')}
                        </button>
                      </div>
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
