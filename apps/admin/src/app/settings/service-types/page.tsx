'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import { formatCUP } from '@tricigo/utils';
import type { ServiceTypeConfig } from '@tricigo/types';

export default function ServiceTypesPage() {
  const [configs, setConfigs] = useState<ServiceTypeConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<ServiceTypeConfig>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetch() {
      try {
        const data = await adminService.getServiceTypeConfigs();
        if (!cancelled) setConfigs(data);
      } catch (err) {
        console.error('Error fetching service types:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch();
    return () => { cancelled = true; };
  }, []);

  function startEdit(config: ServiceTypeConfig) {
    setEditingId(config.id);
    setEditForm({
      name_es: config.name_es,
      name_en: config.name_en,
      base_fare_cup: config.base_fare_cup,
      per_km_rate_cup: config.per_km_rate_cup,
      per_minute_rate_cup: config.per_minute_rate_cup,
      min_fare_cup: config.min_fare_cup,
      max_passengers: config.max_passengers,
    });
  }

  async function handleSave() {
    if (!editingId) return;
    setSaving(true);
    try {
      await adminService.updateServiceTypeConfig(editingId, editForm);
      const data = await adminService.getServiceTypeConfigs();
      setConfigs(data);
      setEditingId(null);
    } catch (err) {
      console.error('Error updating service type:', err);
      window.alert('Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(config: ServiceTypeConfig) {
    try {
      await adminService.updateServiceTypeConfig(config.id, { is_active: !config.is_active });
      setConfigs((prev) => prev.map((c) => c.id === config.id ? { ...c, is_active: !c.is_active } : c));
    } catch (err) {
      console.error('Error toggling:', err);
    }
  }

  function cupInput(field: keyof ServiceTypeConfig) {
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

  return (
    <div>
      <Link href="/settings" className="text-sm text-[#FF4D00] hover:underline mb-4 inline-block">
        ← Volver a configuración
      </Link>
      <h1 className="text-3xl font-bold mb-6">Tipos de servicio</h1>

      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-100">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Slug</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Nombre ES</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Base</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Por KM</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Por Min</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Mín</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Pasajeros</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Activo</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {configs.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-center py-12 text-neutral-400">
                  {loading ? 'Cargando...' : 'Sin tipos de servicio'}
                </td>
              </tr>
            ) : (
              configs.map((c) => (
                <tr key={c.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                  <td className="px-4 py-3 font-mono text-xs">{c.slug}</td>
                  <td className="px-4 py-3">
                    {editingId === c.id ? (
                      <input
                        className="w-32 px-2 py-1 border border-neutral-300 rounded text-sm"
                        value={editForm.name_es ?? ''}
                        onChange={(e) => setEditForm((f) => ({ ...f, name_es: e.target.value }))}
                      />
                    ) : c.name_es}
                  </td>
                  <td className="px-4 py-3">
                    {editingId === c.id ? cupInput('base_fare_cup') : formatCUP(c.base_fare_cup)}
                  </td>
                  <td className="px-4 py-3">
                    {editingId === c.id ? cupInput('per_km_rate_cup') : formatCUP(c.per_km_rate_cup)}
                  </td>
                  <td className="px-4 py-3">
                    {editingId === c.id ? cupInput('per_minute_rate_cup') : formatCUP(c.per_minute_rate_cup)}
                  </td>
                  <td className="px-4 py-3">
                    {editingId === c.id ? cupInput('min_fare_cup') : formatCUP(c.min_fare_cup)}
                  </td>
                  <td className="px-4 py-3">
                    {editingId === c.id ? (
                      <input
                        type="number"
                        className="w-14 px-2 py-1 border border-neutral-300 rounded text-sm"
                        value={editForm.max_passengers ?? 1}
                        onChange={(e) => setEditForm((f) => ({ ...f, max_passengers: parseInt(e.target.value) || 1 }))}
                        min={1}
                        max={10}
                      />
                    ) : c.max_passengers}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleActive(c)}
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        c.is_active ? 'bg-green-100 text-green-700' : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {c.is_active ? 'Activo' : 'Inactivo'}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    {editingId === c.id ? (
                      <div className="flex gap-2">
                        <button
                          onClick={handleSave}
                          disabled={saving}
                          className="px-3 py-1 rounded-lg text-xs font-medium bg-[#FF4D00] text-white hover:bg-[#E64500] disabled:opacity-50"
                        >
                          Guardar
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="px-3 py-1 rounded-lg text-xs font-medium bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startEdit(c)}
                        className="text-sm text-[#FF4D00] hover:underline"
                      >
                        Editar
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
