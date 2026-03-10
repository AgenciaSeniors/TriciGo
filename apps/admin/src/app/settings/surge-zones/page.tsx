'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminService } from '@tricigo/api/services/admin';
import type { SurgeZone } from '@tricigo/types';

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-CU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SurgeZonesPage() {
  const [surges, setSurges] = useState<SurgeZone[]>([]);
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

  useEffect(() => {
    let cancelled = false;
    async function fetch() {
      try {
        const data = await adminService.getSurgeZones();
        if (!cancelled) setSurges(data);
      } catch (err) {
        console.error('Error fetching surge zones:', err);
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
    } catch (err) {
      console.error('Error creating surge zone:', err);
      window.alert('Error al crear zona surge');
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
      console.error('Error toggling surge:', err);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('¿Eliminar esta regla de surge?')) return;
    try {
      await adminService.deleteSurgeZone(id);
      setSurges((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      console.error('Error deleting surge:', err);
    }
  }

  return (
    <div>
      <Link href="/settings" className="text-sm text-[#FF4D00] hover:underline mb-4 inline-block">
        ← Volver a configuración
      </Link>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Zonas de tarifa dinámica</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-[#FF4D00] text-white hover:bg-[#e04400] transition-colors"
        >
          {showCreate ? 'Cancelar' : '+ Crear regla'}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 mb-6">
          <h2 className="text-lg font-bold mb-4">Nueva regla de surge</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="text-sm text-neutral-500 mb-1 block">Zone ID</label>
              <input
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-[#FF4D00]"
                placeholder="UUID de la zona"
                value={form.zone_id}
                onChange={(e) => setForm((f) => ({ ...f, zone_id: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm text-neutral-500 mb-1 block">Multiplicador</label>
              <input
                type="number"
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-[#FF4D00]"
                value={form.multiplier}
                onChange={(e) => setForm((f) => ({ ...f, multiplier: parseFloat(e.target.value) || 1 }))}
                step="0.1"
                min="1"
                max="5"
              />
            </div>
            <div>
              <label className="text-sm text-neutral-500 mb-1 block">Motivo</label>
              <input
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-[#FF4D00]"
                placeholder="Alta demanda, evento, etc."
                value={form.reason}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm text-neutral-500 mb-1 block">Inicio (opcional)</label>
              <input
                type="datetime-local"
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-[#FF4D00]"
                value={form.starts_at}
                onChange={(e) => setForm((f) => ({ ...f, starts_at: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm text-neutral-500 mb-1 block">Fin (opcional)</label>
              <input
                type="datetime-local"
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-[#FF4D00]"
                value={form.ends_at}
                onChange={(e) => setForm((f) => ({ ...f, ends_at: e.target.value }))}
              />
            </div>
          </div>
          <button
            onClick={handleCreate}
            disabled={creating || !form.zone_id}
            className="px-6 py-2 rounded-lg text-sm font-medium bg-[#FF4D00] text-white hover:bg-[#e04400] transition-colors disabled:opacity-50"
          >
            {creating ? 'Creando...' : 'Crear regla'}
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-100">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Multiplicador</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Motivo</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Inicio</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Fin</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Activo</th>
              <th className="text-left px-4 py-3 font-medium text-neutral-500">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {surges.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-12 text-neutral-400">
                  {loading ? 'Cargando...' : 'Sin reglas de surge activas'}
                </td>
              </tr>
            ) : (
              surges.map((s) => (
                <tr key={s.id} className="border-b border-neutral-50 hover:bg-neutral-50">
                  <td className="px-4 py-3">
                    <span className="text-yellow-600 font-bold">{Number(s.multiplier).toFixed(1)}×</span>
                  </td>
                  <td className="px-4 py-3 text-neutral-600">{s.reason || '—'}</td>
                  <td className="px-4 py-3 text-neutral-500 text-xs">{formatDate(s.starts_at)}</td>
                  <td className="px-4 py-3 text-neutral-500 text-xs">{formatDate(s.ends_at)}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleActive(s)}
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        s.active ? 'bg-green-100 text-green-700' : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {s.active ? 'Activo' : 'Inactivo'}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleDelete(s.id)}
                      className="text-sm text-red-500 hover:underline"
                    >
                      Eliminar
                    </button>
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
