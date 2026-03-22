'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import type { SurgeZone } from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { formatAdminDate } from '@/lib/formatDate';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';


export default function SurgeZonesPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [surges, setSurges] = useState<SurgeZone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    zone_id: '',
    multiplier: 1.5,
    reason: '',
    starts_at: '',
    ends_at: '',
  });
  const [confirmModal, setConfirmModal] = useState<{open: boolean; action: () => void; title: string; message: string; variant?: 'danger' | 'warning' | 'default'}>({open: false, action: () => {}, title: '', message: ''});

  useEffect(() => {
    let cancelled = false;
    async function fetch() {
      try {
        const data = await adminService.getSurgeZones();
        if (!cancelled) setSurges(data);
      } catch (err) {
        // Error handled by UI
        setError(err instanceof Error ? err.message : 'Error al cargar zonas surge');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch();
    return () => { cancelled = true; };
  }, []);

  async function handleCreate() {
    if (!form.zone_id || form.multiplier < 1) return;
    setCreating(true);
    try {
      await adminService.createSurgeZone({
        zone_id: form.zone_id,
        multiplier: form.multiplier,
        reason: form.reason || undefined,
        starts_at: form.starts_at || undefined,
        ends_at: form.ends_at || undefined,
      });
      const data = await adminService.getSurgeZones();
      setSurges(data);
      setShowCreate(false);
      setForm({ zone_id: '', multiplier: 1.5, reason: '', starts_at: '', ends_at: '' });
      showToast('success', t('surge_zones.created_success', { defaultValue: 'Zona surge creada' }));
    } catch (err) {
      // Error handled by UI
      showToast('error', t('surge_zones.error_creating', { defaultValue: 'Error al crear zona surge' }));
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(surge: SurgeZone) {
    try {
      await adminService.updateSurgeZone(surge.id, { active: !surge.active });
      setSurges((prev) =>
        prev.map((s) => (s.id === surge.id ? { ...s, active: !s.active } : s)),
      );
    } catch (err) {
      // Error handled by UI
    }
  }

  async function handleDelete(id: string) {
    setConfirmModal({open: true, title: t('surge_zones.confirm_delete'), message: t('surge_zones.confirm_delete'), variant: 'danger', action: async () => {
      setConfirmModal(prev => ({...prev, open: false}));
      try {
        await adminService.deleteSurgeZone(id);
        setSurges((prev) => prev.filter((s) => s.id !== id));
      } catch {
        // Error handled silently
      }
    }});
  }

  return (
    <div>
      <Link href="/settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>
      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); }}
          onDismiss={() => setError(null)}
        />
      )}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">{t('surge_zones.title')}</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors"
        >
          {showCreate ? t('common.cancel') : t('surge_zones.create_rule')}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-6">
          <h2 className="text-lg font-bold mb-4">{t('surge_zones.new_rule_title')}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="text-sm text-neutral-500 mb-1 block">{t('surge_zones.label_zone_id')}</label>
              <input
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-primary-500"
                placeholder={t('surge_zones.zone_placeholder')}
                value={form.zone_id}
                onChange={(e) => setForm((f) => ({ ...f, zone_id: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm text-neutral-500 mb-1 block">{t('surge_zones.label_multiplier')}</label>
              <input
                type="number"
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-primary-500"
                value={form.multiplier}
                onChange={(e) => setForm((f) => ({ ...f, multiplier: parseFloat(e.target.value) || 1 }))}
                step="0.1"
                min="1"
                max="5"
              />
            </div>
            <div>
              <label className="text-sm text-neutral-500 mb-1 block">{t('surge_zones.label_reason')}</label>
              <input
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-primary-500"
                placeholder={t('surge_zones.reason_placeholder')}
                value={form.reason}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm text-neutral-500 mb-1 block">{t('surge_zones.label_start')}</label>
              <input
                type="datetime-local"
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-primary-500"
                value={form.starts_at}
                onChange={(e) => setForm((f) => ({ ...f, starts_at: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm text-neutral-500 mb-1 block">{t('surge_zones.label_end')}</label>
              <input
                type="datetime-local"
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-primary-500"
                value={form.ends_at}
                onChange={(e) => setForm((f) => ({ ...f, ends_at: e.target.value }))}
              />
            </div>
          </div>
          <button
            onClick={handleCreate}
            disabled={creating || !form.zone_id}
            className="px-6 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50"
          >
            {creating ? t('surge_zones.creating') : t('surge_zones.create_rule_btn')}
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-100">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('surge_zones.col_multiplier')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('surge_zones.col_reason')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('surge_zones.col_start')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('surge_zones.col_end')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('surge_zones.col_active')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {surges.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-12 text-neutral-400">
                  {loading ? t('common.loading') : t('surge_zones.no_rules')}
                </td>
              </tr>
            ) : (
              surges.map((s) => (
                <tr key={s.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                  <td className="px-4 py-3">
                    <span className="text-yellow-600 font-bold">{Number(s.multiplier).toFixed(1)}x</span>
                  </td>
                  <td className="px-4 py-3 text-neutral-600">{s.reason || '—'}</td>
                  <td className="px-4 py-3 text-neutral-500 text-xs">{formatAdminDate(s.starts_at)}</td>
                  <td className="px-4 py-3 text-neutral-500 text-xs">{formatAdminDate(s.ends_at)}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleActive(s)}
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        s.active ? 'bg-green-100 text-green-700' : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {s.active ? t('common.active') : t('common.inactive')}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleDelete(s.id)}
                      className="text-sm text-red-500 hover:underline"
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <AdminConfirmModal
        open={confirmModal.open}
        title={confirmModal.title}
        message={confirmModal.message}
        variant={confirmModal.variant}
        onConfirm={confirmModal.action}
        onCancel={() => setConfirmModal(prev => ({...prev, open: false}))}
      />
    </div>
  );
}
