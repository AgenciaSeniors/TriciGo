'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapPin, Plus, X, Lock, Unlock, EyeOff, Eye } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { poiService, TRICIGO_CATEGORIES } from '@tricigo/api';
import type { Poi, PoiInput, TriciGoCategory, PoiSource } from '@tricigo/api';
import { useToast } from '@/components/ui/AdminToast';
import { AdminConfirmModal } from '@/components/ui/AdminConfirmModal';
import { DataTable, type DataColumn } from '@/components/data/DataTable';
import { formatAdminDate } from '@/lib/formatDate';

const PAGE_SIZE = 50;

const SOURCES: PoiSource[] = ['admin', 'osm', 'overture', 'foursquare', 'merged'];

const emptyForm: PoiInput & { _editingId: number | null } = {
  _editingId: null,
  name: '',
  tricigo_category: 'other',
  latitude: 23.1136,    // central Havana — user picks via map or types in
  longitude: -82.3666,
  address: '',
  municipality: '',
  province: '',
  phone: '',
  website: '',
  hours: '',
};

export default function PoisAdminPage() {
  const { t } = useTranslation('admin');
  const { showToast } = useToast();

  const [pois, setPois] = useState<Poi[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // Filters
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<TriciGoCategory | 'all'>('all');
  const [source, setSource] = useState<PoiSource | 'all'>('all');
  const [onlyAdmin, setOnlyAdmin] = useState(false);
  const [onlyActive, setOnlyActive] = useState(true);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);

  // Confirm modals
  const [deactivateTarget, setDeactivateTarget] = useState<Poi | null>(null);
  const [unlockTarget, setUnlockTarget] = useState<Poi | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await poiService.list(page, {
        search,
        category,
        source,
        onlyAdmin,
        onlyActive,
      });
      setPois(result.rows);
      setTotal(result.total);
    } catch (err) {
      setPois([]);
      setTotal(0);
      setError(err instanceof Error ? err.message : 'No pudimos cargar los POIs.');
    } finally {
      setLoading(false);
    }
  }, [page, search, category, source, onlyAdmin, onlyActive]);

  // Reload on filter change with a short debounce on the search box so we
  // don't hammer the RPC with each keystroke
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const resetForm = () => {
    setForm({ ...emptyForm });
    setShowForm(false);
  };

  const openCreate = () => {
    setForm({ ...emptyForm });
    setShowForm(true);
  };

  const openEdit = (poi: Poi) => {
    setForm({
      _editingId: poi.id,
      name: poi.name,
      tricigo_category: (poi.tricigo_category ?? 'other') as TriciGoCategory,
      latitude: poi.latitude,
      longitude: poi.longitude,
      address: poi.address ?? '',
      municipality: poi.municipality ?? '',
      province: poi.province ?? '',
      phone: poi.phone ?? '',
      website: poi.website ?? '',
      hours: poi.hours ?? '',
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      showToast('error', 'El nombre es obligatorio.');
      return;
    }
    setSaving(true);
    try {
      const payload: PoiInput = {
        name: form.name,
        tricigo_category: form.tricigo_category,
        latitude: form.latitude,
        longitude: form.longitude,
        address: form.address || null,
        municipality: form.municipality || null,
        province: form.province || null,
        phone: form.phone || null,
        website: form.website || null,
        hours: form.hours || null,
      };
      if (form._editingId) {
        await poiService.update(form._editingId, payload);
        showToast('success', 'POI actualizado');
      } else {
        await poiService.create(payload);
        showToast('success', 'POI creado');
      }
      resetForm();
      await load();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No pudimos guardar el POI.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async (poi: Poi) => {
    try {
      await poiService.deactivate(poi.id);
      showToast('success', 'POI desactivado');
      setDeactivateTarget(null);
      await load();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No pudimos desactivar.');
    }
  };

  const handleActivate = async (poi: Poi) => {
    try {
      await poiService.activate(poi.id);
      showToast('success', 'POI activado');
      await load();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No pudimos activar.');
    }
  };

  const handleUnlock = async (poi: Poi) => {
    try {
      await poiService.unlock(poi.id);
      showToast('success', 'POI desbloqueado — el próximo sync lo refrescará');
      setUnlockTarget(null);
      await load();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'No pudimos desbloquear.');
    }
  };

  const columns = useMemo<DataColumn<Poi>[]>(() => [
    {
      id: 'name',
      header: 'Nombre',
      cell: (p) => (
        <div className="flex flex-col">
          <span className="font-semibold text-neutral-900 dark:text-neutral-100">{p.name}</span>
          {p.address && (
            <span className="text-xs text-neutral-500 truncate max-w-md">{p.address}</span>
          )}
        </div>
      ),
    },
    {
      id: 'category',
      header: 'Categoría',
      cell: (p) => p.tricigo_category ? (
        <span className="px-2 py-0.5 rounded text-xs bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
          {p.tricigo_category}
        </span>
      ) : <span className="text-xs text-neutral-400">—</span>,
    },
    {
      id: 'municipality',
      header: 'Municipio',
      cell: (p) => p.municipality ?? <span className="text-neutral-400">—</span>,
    },
    {
      id: 'source',
      header: 'Fuente',
      cell: (p) => (
        <span className={
          'px-2 py-0.5 rounded text-xs ' +
          (p.source === 'admin'      ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200' :
           p.source === 'osm'        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200' :
           p.source === 'overture'   ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200' :
           p.source === 'foursquare' ? 'bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-200' :
                                       'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200')
        }>
          {p.source}
        </span>
      ),
    },
    {
      id: 'flags',
      header: 'Estado',
      cell: (p) => (
        <div className="flex gap-1">
          {p.is_admin && (
            <span title="Bloqueado contra sync" className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300">
              ADMIN
            </span>
          )}
          {!p.is_active && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
              CERRADO
            </span>
          )}
        </div>
      ),
    },
    {
      id: 'updated_at',
      header: 'Actualizado',
      cell: (p) => <span className="text-xs text-neutral-500">{formatAdminDate(p.updated_at)}</span>,
    },
    {
      id: 'actions',
      header: '',
      cell: (p) => (
        <div className="flex items-center gap-1 justify-end">
          <button
            onClick={() => openEdit(p)}
            className="text-xs px-2 py-1 rounded hover:bg-surface-sunken"
          >
            Editar
          </button>
          {p.is_active ? (
            <button
              onClick={() => setDeactivateTarget(p)}
              title="Desactivar"
              className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400"
            >
              <EyeOff size={14} />
            </button>
          ) : (
            <button
              onClick={() => handleActivate(p)}
              title="Reactivar"
              className="p-1.5 rounded hover:bg-green-50 dark:hover:bg-green-900/20 text-green-600 dark:text-green-400"
            >
              <Eye size={14} />
            </button>
          )}
          {p.is_admin && p.source !== 'admin' && (
            <button
              onClick={() => setUnlockTarget(p)}
              title="Desbloquear (permitir que el próximo sync lo refresque)"
              className="p-1.5 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20 text-blue-600 dark:text-blue-400"
            >
              <Unlock size={14} />
            </button>
          )}
          {!p.is_admin && (
            <span title="Sync puede sobrescribir este POI" className="p-1.5 text-neutral-400">
              <Lock size={14} />
            </span>
          )}
        </div>
      ),
    },
  ], []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MapPin className="text-orange-500" />
            POIs (Cuba)
          </h1>
          <p className="text-sm text-neutral-500 mt-1">
            {total.toLocaleString()} resultados — admin override sticky vs sync mensual
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg font-medium"
        >
          <Plus size={16} /> Agregar POI
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input
            type="search"
            placeholder="Buscar por nombre..."
            value={search}
            onChange={(e) => { setPage(0); setSearch(e.target.value); }}
            className="px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded-md text-sm"
          />
          <select
            value={category}
            onChange={(e) => { setPage(0); setCategory(e.target.value as TriciGoCategory | 'all'); }}
            className="px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded-md text-sm"
          >
            <option value="all">Todas las categorías</option>
            {TRICIGO_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select
            value={source}
            onChange={(e) => { setPage(0); setSource(e.target.value as PoiSource | 'all'); }}
            className="px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded-md text-sm"
          >
            <option value="all">Todas las fuentes</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyAdmin}
                onChange={(e) => { setPage(0); setOnlyAdmin(e.target.checked); }}
              />
              Solo admin
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyActive}
                onChange={(e) => { setPage(0); setOnlyActive(e.target.checked); }}
              />
              Solo activos
            </label>
          </div>
        </div>
      </div>

      {/* Table */}
      {error ? (
        <div className="text-red-600 p-4 bg-red-50 dark:bg-red-900/10 rounded">{error}</div>
      ) : (
        <DataTable
          rows={pois}
          columns={columns}
          loading={loading}
          keyField="id"
          empty={{
            icon: MapPin,
            title: 'Sin POIs',
            body: 'No hay POIs que coincidan con los filtros',
          }}
        />
      )}

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 text-sm">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-700 disabled:opacity-50"
          >
            Anterior
          </button>
          <span className="text-neutral-500">Página {page + 1} de {totalPages}</span>
          <button
            onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
            className="px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-700 disabled:opacity-50"
          >
            Siguiente
          </button>
        </div>
      )}

      {/* Form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-neutral-900 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-neutral-200 dark:border-neutral-800 sticky top-0 bg-white dark:bg-neutral-900">
              <h2 className="text-lg font-semibold">
                {form._editingId ? 'Editar POI' : 'Agregar POI'}
              </h2>
              <button onClick={resetForm} className="p-1 hover:bg-surface-sunken rounded">
                <X size={20} />
              </button>
            </div>
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-xs font-medium mb-1">Nombre *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded-md text-sm"
                  placeholder="ej. Paladar Las Margaritas"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Categoría *</label>
                <select
                  value={form.tricigo_category}
                  onChange={(e) => setForm({ ...form, tricigo_category: e.target.value as TriciGoCategory })}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded-md text-sm"
                >
                  {TRICIGO_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Municipio</label>
                <input
                  type="text"
                  value={form.municipality ?? ''}
                  onChange={(e) => setForm({ ...form, municipality: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded-md text-sm"
                  placeholder="ej. Centro Habana"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Latitud *</label>
                <input
                  type="number"
                  step="0.000001"
                  value={form.latitude}
                  onChange={(e) => setForm({ ...form, latitude: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded-md text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Longitud *</label>
                <input
                  type="number"
                  step="0.000001"
                  value={form.longitude}
                  onChange={(e) => setForm({ ...form, longitude: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded-md text-sm font-mono"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium mb-1">Dirección</label>
                <input
                  type="text"
                  value={form.address ?? ''}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded-md text-sm"
                  placeholder="ej. Calle 23 e/ M y N"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Provincia</label>
                <input
                  type="text"
                  value={form.province ?? ''}
                  onChange={(e) => setForm({ ...form, province: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded-md text-sm"
                  placeholder="ej. La Habana"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Teléfono</label>
                <input
                  type="tel"
                  value={form.phone ?? ''}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded-md text-sm"
                  placeholder="+5378334501"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Website</label>
                <input
                  type="url"
                  value={form.website ?? ''}
                  onChange={(e) => setForm({ ...form, website: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded-md text-sm"
                  placeholder="https://ejemplo.com"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Horarios</label>
                <input
                  type="text"
                  value={form.hours ?? ''}
                  onChange={(e) => setForm({ ...form, hours: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 rounded-md text-sm"
                  placeholder="ej. Mo-Su 12:00-23:00"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-neutral-200 dark:border-neutral-800 sticky bottom-0 bg-white dark:bg-neutral-900">
              <button
                onClick={resetForm}
                className="px-4 py-2 rounded border border-neutral-300 dark:border-neutral-700 text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !form.name.trim()}
                className="px-4 py-2 rounded bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium disabled:opacity-50"
              >
                {saving ? 'Guardando...' : (form._editingId ? 'Guardar' : 'Crear')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm: deactivate */}
      <AdminConfirmModal
        open={deactivateTarget !== null}
        title="Desactivar POI"
        message={`¿Confirmás desactivar "${deactivateTarget?.name}"? Dejará de aparecer en búsquedas hasta que lo reactives.`}
        confirmLabel="Desactivar"
        variant="danger"
        onConfirm={() => deactivateTarget && handleDeactivate(deactivateTarget)}
        onCancel={() => setDeactivateTarget(null)}
      />

      {/* Confirm: unlock */}
      <AdminConfirmModal
        open={unlockTarget !== null}
        title="Desbloquear POI"
        message={`Si desbloqueás "${unlockTarget?.name}", el próximo sync mensual podrá sobrescribir tus ediciones con los datos de OSM/Overture/Foursquare. ¿Confirmás?`}
        confirmLabel="Desbloquear"
        variant="warning"
        onConfirm={() => unlockTarget && handleUnlock(unlockTarget)}
        onCancel={() => setUnlockTarget(null)}
      />
    </div>
  );
}
