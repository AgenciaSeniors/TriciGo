'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';
import type { Zone } from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';

const TYPE_BADGE: Record<string, string> = {
  operational: 'bg-green-100 text-green-700',
  surge: 'bg-yellow-100 text-yellow-700',
  restricted: 'bg-red-100 text-red-700',
};

const TYPE_LABEL_KEY: Record<string, string> = {
  operational: 'zones.type_operational',
  surge: 'zones.type_surge',
  restricted: 'zones.type_restricted',
};

type ZoneRow = Omit<Zone, 'boundary'>;

export default function ZonesPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; surge_multiplier: number }>({ name: '', surge_multiplier: 1 });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetch() {
      try {
        const data = await adminService.getZones();
        if (!cancelled) setZones(data);
      } catch (err) {
        // Error handled by UI
        setError(err instanceof Error ? err.message : 'Error al cargar zonas');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch();
    return () => { cancelled = true; };
  }, []);

  function startEdit(zone: ZoneRow) {
    setEditingId(zone.id);
    setEditForm({ name: zone.name, surge_multiplier: zone.surge_multiplier });
  }

  async function handleSave() {
    if (!editingId) return;
    setSaving(true);
    try {
      await adminService.updateZone(editingId, editForm);
      const data = await adminService.getZones();
      setZones(data);
      setEditingId(null);
    } catch (err) {
      // Error handled by UI
      showToast('error', 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(zone: ZoneRow) {
    try {
      await adminService.updateZone(zone.id, { is_active: !zone.is_active });
      setZones((prev) => prev.map((z) => z.id === zone.id ? { ...z, is_active: !z.is_active } : z));
    } catch (err) {
      // Error handled by UI
    }
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
      <h1 className="text-3xl font-bold mb-6">{t('zones.title')}</h1>

      <p className="text-sm text-neutral-500 mb-4">
        {t('zones.map_note')}
      </p>

      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-100">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('zones.col_name')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('zones.col_type')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('zones.col_surge_multiplier')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('zones.col_active')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {zones.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center py-12 text-neutral-400">
                  {loading ? t('common.loading') : t('zones.no_zones')}
                </td>
              </tr>
            ) : (
              zones.map((z) => (
                <tr key={z.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                  <td className="px-4 py-3 font-medium">
                    {editingId === z.id ? (
                      <input
                        className="w-40 px-2 py-1 border border-neutral-300 rounded text-sm"
                        value={editForm.name}
                        onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                      />
                    ) : z.name}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_BADGE[z.type] ?? 'bg-neutral-100 text-neutral-700'}`}>
                      {TYPE_LABEL_KEY[z.type] ? t(TYPE_LABEL_KEY[z.type]!) : z.type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {editingId === z.id ? (
                      <input
                        type="number"
                        className="w-20 px-2 py-1 border border-neutral-300 rounded text-sm"
                        value={editForm.surge_multiplier}
                        onChange={(e) => setEditForm((f) => ({ ...f, surge_multiplier: parseFloat(e.target.value) || 1 }))}
                        step="0.05"
                        min="1"
                        max="5"
                      />
                    ) : (
                      <span className={z.surge_multiplier > 1 ? 'text-yellow-600 font-medium' : ''}>
                        {z.surge_multiplier.toFixed(2)}x
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleActive(z)}
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        z.is_active ? 'bg-green-100 text-green-700' : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {z.is_active ? t('common.active') : t('common.inactive')}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    {editingId === z.id ? (
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
                      <button
                        onClick={() => startEdit(z)}
                        className="text-sm text-primary-500 hover:underline"
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
    </div>
  );
}
