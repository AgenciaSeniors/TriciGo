'use client';

import { useCallback, useEffect, useState } from 'react';
import { MapPin, Check, X, ExternalLink, Filter } from 'lucide-react';
import { getSupabaseClient } from '@tricigo/api';
import { useToast } from '@/components/ui/AdminToast';

// ============================================================
// POI moderation panel (PR 3 of POI parity program)
//
// Lists crowdsourced submissions awaiting admin review. Each row has:
//   - Name, category, submitter role, time submitted
//   - Lat/lng + "Ver en Google Maps" link
//   - Approve button → adds to cuba_pois with source='crowdsource'
//   - Reject button → prompts for reason
//
// MVP scope: list pending + approve/reject. No map preview, no bulk
// actions, no filtering by submitter — those are follow-ups.
// ============================================================

interface Submission {
  id: string;
  submitted_by: string;
  name: string;
  tricigo_category: string;
  lat: number;
  lng: number;
  address: string | null;
  notes: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'duplicate';
  submitter_role: 'driver' | 'client' | null;
  created_at: string;
  moderator_id: string | null;
  moderated_at: string | null;
  rejection_reason: string | null;
  promoted_poi_id: number | null;
}

type StatusFilter = 'pending' | 'approved' | 'rejected' | 'all';

export default function PoisSubmissionsPage() {
  const { showToast } = useToast();
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = getSupabaseClient();
      const { data, error: err } = await supabase.rpc('list_poi_submissions', {
        p_status: status,
        p_limit: 100,
        p_offset: 0,
      });
      if (err) throw err;
      setSubmissions((data as Submission[]) ?? []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'No pudimos cargar las sugerencias.';
      setError(msg);
      setSubmissions([]);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const handleApprove = async (id: string) => {
    if (!confirm('¿Aprobar este lugar? Va a aparecer en el mapa para todos.')) return;
    setActingId(id);
    try {
      const supabase = getSupabaseClient();
      const { data, error: err } = await supabase.rpc('approve_poi_submission', {
        p_submission_id: id,
      });
      if (err) throw err;
      const result = data as { success?: boolean; error?: string; promoted_poi_id?: number };
      if (result?.error) {
        showToast('error', `Error: ${result.error}`);
      } else {
        showToast('success', `Aprobado — POI #${result.promoted_poi_id}`);
        load();
      }
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Falló');
    } finally {
      setActingId(null);
    }
  };

  const handleReject = async (id: string) => {
    const reason = prompt('Motivo del rechazo (visible para el usuario):');
    if (!reason || !reason.trim()) return;
    setActingId(id);
    try {
      const supabase = getSupabaseClient();
      const { data, error: err } = await supabase.rpc('reject_poi_submission', {
        p_submission_id: id,
        p_reason: reason.trim(),
      });
      if (err) throw err;
      const result = data as { success?: boolean; error?: string };
      if (result?.error) {
        showToast('error', `Error: ${result.error}`);
      } else {
        showToast('success', 'Rechazado');
        load();
      }
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Falló');
    } finally {
      setActingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">
            Sugerencias de lugares
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            POIs propuestos por drivers y clientes desde la app. Aprobar agrega el lugar al mapa.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Filter size={16} className="text-neutral-500" />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            className="px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-sm"
          >
            <option value="pending">Pendientes</option>
            <option value="approved">Aprobados</option>
            <option value="rejected">Rechazados</option>
            <option value="all">Todos</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="p-8 text-center text-neutral-500">Cargando...</div>
      ) : submissions.length === 0 ? (
        <div className="p-8 text-center text-neutral-500">
          No hay sugerencias {status === 'pending' ? 'pendientes' : status === 'approved' ? 'aprobadas' : status === 'rejected' ? 'rechazadas' : ''} todavía.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Nombre</th>
                <th className="px-4 py-3 text-left font-semibold">Categoría</th>
                <th className="px-4 py-3 text-left font-semibold">Ubicación</th>
                <th className="px-4 py-3 text-left font-semibold">Submitido por</th>
                <th className="px-4 py-3 text-left font-semibold">Fecha</th>
                <th className="px-4 py-3 text-right font-semibold">Acción</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => (
                <tr key={s.id} className="border-t border-neutral-200 dark:border-neutral-700">
                  <td className="px-4 py-3">
                    <div className="font-medium text-neutral-900 dark:text-white">{s.name}</div>
                    {s.notes && <div className="text-xs text-neutral-500 mt-1">Nota: {s.notes}</div>}
                    {s.rejection_reason && (
                      <div className="text-xs text-red-500 mt-1">Razón rechazo: {s.rejection_reason}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">{s.tricigo_category}</td>
                  <td className="px-4 py-3">
                    <a
                      href={`https://www.google.com/maps?q=${s.lat},${s.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-xs"
                    >
                      <MapPin size={12} />
                      {s.lat.toFixed(5)}, {s.lng.toFixed(5)}
                      <ExternalLink size={11} />
                    </a>
                    {s.address && (
                      <div className="text-xs text-neutral-500 mt-1 max-w-xs">{s.address}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        s.submitter_role === 'driver'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                          : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                      }`}
                    >
                      {s.submitter_role ?? 'unknown'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-neutral-500">
                    {new Date(s.created_at).toLocaleString('es-CU', { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {s.status === 'pending' ? (
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => handleApprove(s.id)}
                          disabled={actingId === s.id}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-green-500 hover:bg-green-600 disabled:opacity-40 text-white text-xs font-semibold"
                        >
                          <Check size={14} />
                          Aprobar
                        </button>
                        <button
                          onClick={() => handleReject(s.id)}
                          disabled={actingId === s.id}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 disabled:opacity-40 text-white text-xs font-semibold"
                        >
                          <X size={14} />
                          Rechazar
                        </button>
                      </div>
                    ) : s.status === 'approved' ? (
                      <span className="text-xs text-green-600 dark:text-green-400">
                        ✓ Aprobado{s.promoted_poi_id ? ` (POI #${s.promoted_poi_id})` : ''}
                      </span>
                    ) : s.status === 'rejected' ? (
                      <span className="text-xs text-red-600 dark:text-red-400">✗ Rechazado</span>
                    ) : (
                      <span className="text-xs text-neutral-500">{s.status}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
