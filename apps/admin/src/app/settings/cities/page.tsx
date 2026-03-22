'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import { createBrowserClient } from '@/lib/supabase-server';
import { useToast } from '@/components/ui/AdminToast';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';

type City = {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  timezone: string;
  bounds: unknown;
  created_at: string;
  rides_count?: number;
};

export default function CitiesPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();
  const [cities, setCities] = useState<City[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; timezone: string }>({ name: '', timezone: '' });
  const [saving, setSaving] = useState(false);

  const fetchCities = useCallback(async () => {
    setLoading(true);
    try {
      const supabase = createBrowserClient();

      // Fetch cities
      const { data: citiesData, error: citiesError } = await supabase
        .from('cities')
        .select('*')
        .order('name');

      if (citiesError) throw citiesError;

      // Fetch rides count per city
      const { data: rideCounts, error: ridesError } = await supabase
        .from('rides')
        .select('city_id');

      if (ridesError) {
        // Error handled by UI
      }

      // Count rides per city
      const countMap = new Map<string, number>();
      if (rideCounts) {
        for (const r of rideCounts) {
          if (r.city_id) {
            countMap.set(r.city_id, (countMap.get(r.city_id) ?? 0) + 1);
          }
        }
      }

      const enriched = (citiesData ?? []).map((c: any) => ({
        ...c,
        rides_count: countMap.get(c.id) ?? 0,
      }));

      setCities(enriched);
    } catch (err) {
      // Error handled by UI
      setError(err instanceof Error ? err.message : 'Error al cargar ciudades');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCities();
  }, [fetchCities]);

  async function toggleActive(city: City) {
    try {
      const supabase = createBrowserClient();
      const { error } = await supabase
        .from('cities')
        .update({ is_active: !city.is_active })
        .eq('id', city.id);

      if (error) throw error;
      setCities((prev) => prev.map((c) => c.id === city.id ? { ...c, is_active: !c.is_active } : c));
    } catch (err) {
      // Error handled by UI
    }
  }

  function startEdit(city: City) {
    setEditingId(city.id);
    setEditForm({ name: city.name, timezone: city.timezone });
  }

  async function handleSave() {
    if (!editingId) return;
    setSaving(true);
    try {
      const supabase = createBrowserClient();
      const { error } = await supabase
        .from('cities')
        .update({ name: editForm.name, timezone: editForm.timezone })
        .eq('id', editingId);

      if (error) throw error;
      await fetchCities();
      setEditingId(null);
    } catch (err) {
      // Error handled by UI
      showToast('error', t('cities.error_saving'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <Link href="/settings" aria-label="Back to settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>
      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => { setError(null); fetchCities(); }}
          onDismiss={() => setError(null)}
        />
      )}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">{t('cities.title')}</h1>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-neutral-50 border-b border-neutral-100">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('cities.col_name')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('cities.col_slug')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('cities.col_timezone')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('cities.col_rides')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('cities.col_bounds')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('cities.col_active')}</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {cities.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-neutral-400">
                  {loading ? t('common.loading') : t('cities.no_cities')}
                </td>
              </tr>
            ) : (
              cities.map((city) => (
                <tr key={city.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                  <td className="px-4 py-3">
                    {editingId === city.id ? (
                      <input
                        type="text"
                        aria-label={t('cities.col_name')}
                        className="w-full px-2 py-1 border border-neutral-300 rounded text-sm"
                        value={editForm.name}
                        onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                      />
                    ) : (
                      <span className="font-medium text-neutral-900">{city.name}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-neutral-500 font-mono text-xs">{city.slug}</td>
                  <td className="px-4 py-3">
                    {editingId === city.id ? (
                      <input
                        type="text"
                        aria-label={t('cities.col_timezone')}
                        className="w-40 px-2 py-1 border border-neutral-300 rounded text-sm"
                        value={editForm.timezone}
                        onChange={(e) => setEditForm((f) => ({ ...f, timezone: e.target.value }))}
                      />
                    ) : (
                      <span className="text-neutral-600 text-xs">{city.timezone}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-neutral-600">{city.rides_count ?? 0}</td>
                  <td className="px-4 py-3 text-neutral-400 text-xs">
                    {city.bounds ? t('cities.bounds_configured') : t('cities.bounds_none')}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleActive(city)}
                      aria-label={city.is_active ? `${t('common.deactivate', { defaultValue: 'Deactivate' })} ${city.name}` : `${t('common.activate', { defaultValue: 'Activate' })} ${city.name}`}
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        city.is_active ? 'bg-green-100 text-green-700' : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {city.is_active ? t('common.active') : t('common.inactive')}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    {editingId === city.id ? (
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
                        onClick={() => startEdit(city)}
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
