'use client';

// ============================================================
// TriciGo Admin — Fleet review panel (Phase 5)
// Shown inside /businesses/[id] for accounts where
// is_fleet_owner = true. Lists fleet_members with status badges
// and approve/reject buttons per row, plus the high-level fleet
// metadata (vehicle types, zones, hours).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { fleetService } from '@tricigo/api';
import { getSupabaseClient } from '@tricigo/api';
import type { DriverFleet, FleetMember, FleetMemberStatus } from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';

interface Props {
  corporateAccountId: string;
  adminUserId: string;
}

const STATUS_COLORS: Record<FleetMemberStatus, string> = {
  pending_review: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-blue-100 text-blue-800',
  rejected: 'bg-red-100 text-red-700',
  pending_signup: 'bg-amber-100 text-amber-700',
  active: 'bg-green-100 text-green-800',
  inactive: 'bg-surface-sunken text-ink-muted',
};

const STATUS_LABELS: Record<FleetMemberStatus, string> = {
  pending_review: 'Pendiente revisión',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  pending_signup: 'Esperando registro',
  active: 'Activo',
  inactive: 'Inactivo',
};

export function FleetReview({ corporateAccountId, adminUserId }: Props) {
  const { showToast } = useToast();
  const [fleet, setFleet] = useState<DriverFleet | null>(null);
  const [members, setMembers] = useState<FleetMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const supabase = getSupabaseClient();
      const { data: fleetRow } = await supabase
        .from('driver_fleets')
        .select('*')
        .eq('corporate_account_id', corporateAccountId)
        .maybeSingle();
      if (!fleetRow) {
        setFleet(null);
        setMembers([]);
        return;
      }
      setFleet(fleetRow as DriverFleet);
      const { data: rows } = await supabase
        .from('fleet_members')
        .select('*')
        .eq('fleet_id', fleetRow.id)
        .order('added_at', { ascending: true });
      setMembers((rows ?? []) as FleetMember[]);
    } finally {
      setLoading(false);
    }
  }, [corporateAccountId]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const approve = async (id: string) => {
    setActionId(id);
    try {
      await fleetService.approveMember(id, adminUserId);
      showToast('success', 'Conductor aprobado');
      await fetchData();
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Error al aprobar');
    } finally {
      setActionId(null);
    }
  };

  const reject = async (id: string) => {
    if (!rejectReason.trim()) return;
    setActionId(id);
    try {
      await fleetService.rejectMember(id, adminUserId, rejectReason.trim());
      showToast('success', 'Conductor rechazado');
      setRejectingId(null);
      setRejectReason('');
      await fetchData();
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Error al rechazar');
    } finally {
      setActionId(null);
    }
  };

  if (loading) {
    return <p className="text-sm text-ink-muted">Cargando flota…</p>;
  }

  if (!fleet) {
    return <p className="text-sm text-ink-muted">Esta cuenta corporativa todavía no tiene flota registrada.</p>;
  }

  return (
    <div className="space-y-5">
      {/* Fleet meta */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <Meta label="Vehículos" value={fleet.vehicle_count_estimate ?? '—'} />
        <Meta label="Tipos" value={fleet.vehicle_types.join(', ') || '—'} />
        <Meta label="Zonas" value={fleet.operating_zones.join(', ') || '—'} />
        <Meta
          label="Horario"
          value={fleet.operating_hours_start && fleet.operating_hours_end
            ? `${fleet.operating_hours_start} – ${fleet.operating_hours_end}`
            : '—'}
        />
      </div>

      {/* Members table */}
      <div>
        <h4 className="text-sm font-medium text-ink mb-2">Conductores ({members.length})</h4>
        {members.length === 0 ? (
          <p className="text-sm text-ink-subtle">Sin conductores en la solicitud.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-ink-muted">
                <th className="pb-2 pr-2">Nombre</th>
                <th className="pb-2 pr-2">Teléfono</th>
                <th className="pb-2 pr-2">Licencia</th>
                <th className="pb-2 pr-2">Estado</th>
                <th className="pb-2 pr-2 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b last:border-0 align-top">
                  <td className="py-2 pr-2">
                    <div className="font-medium">{m.driver_name}</div>
                    {m.driver_email && <div className="text-xs text-ink-muted">{m.driver_email}</div>}
                  </td>
                  <td className="py-2 pr-2 text-ink-muted">{m.driver_phone}</td>
                  <td className="py-2 pr-2 text-ink-muted">
                    {m.driver_license_number ?? '—'}
                    {m.license_doc_path && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-green-700">doc ✓</span>
                    )}
                  </td>
                  <td className="py-2 pr-2">
                    <span className={`px-2 py-0.5 rounded text-xs ${STATUS_COLORS[m.status]}`}>
                      {STATUS_LABELS[m.status]}
                    </span>
                    {m.rejected_reason && (
                      <div className="text-[11px] text-red-600 mt-1">{m.rejected_reason}</div>
                    )}
                  </td>
                  <td className="py-2 pr-2">
                    {m.status === 'pending_review' && (
                      <div className="flex gap-2 justify-end">
                        <button
                          className="px-3 py-1 bg-green-600 text-white rounded text-xs disabled:opacity-50"
                          onClick={() => approve(m.id)}
                          disabled={actionId === m.id}
                        >
                          Aprobar
                        </button>
                        <button
                          className="px-3 py-1 bg-red-600 text-white rounded text-xs disabled:opacity-50"
                          onClick={() => { setRejectingId(m.id); setRejectReason(''); }}
                          disabled={actionId === m.id}
                        >
                          Rechazar
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Reject modal */}
      {rejectingId && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div role="dialog" aria-modal="true" className="bg-surface-elevated rounded-xl p-6 w-full max-w-md">
            <h3 className="text-lg font-bold mb-4">Rechazar conductor</h3>
            <textarea
              className="w-full border rounded-lg p-3 text-sm mb-4"
              rows={3}
              placeholder="Motivo del rechazo"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
            <div className="flex gap-2 justify-end">
              <button
                className="px-4 py-2 text-sm bg-surface-sunken text-ink rounded-lg"
                onClick={() => { setRejectingId(null); setRejectReason(''); }}
              >
                Cancelar
              </button>
              <button
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg disabled:opacity-50"
                onClick={() => reject(rejectingId)}
                disabled={!rejectReason.trim() || actionId === rejectingId}
              >
                Rechazar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-surface-sunken border rounded-lg p-3">
      <div className="text-[11px] uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="font-medium text-ink mt-0.5">{value}</div>
    </div>
  );
}
