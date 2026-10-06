'use client';

// ============================================================
// TriciGo Admin — Fleet review panel (Phase 5)
// Shown inside /businesses/[id] for fleet accounts: a driver_fleets
// row or is_fleet_owner = true. Lists fleet_members with status badges
// and approve/reject buttons per row, plus the high-level fleet
// metadata (vehicle types, zones, hours).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { fleetService } from '@tricigo/api';
import { getSupabaseClient } from '@tricigo/api';
import { FLEET_MEMBER_REVIEWED_FIELDS } from '@tricigo/types';
import type { DriverFleet, FleetMember, FleetMemberReviewedField, FleetMemberStatus } from '@tricigo/types';
import { useToast } from '@/components/ui/AdminToast';

interface Props {
  corporateAccountId: string;
  adminUserId: string;
}

const STATUS_COLORS: Record<FleetMemberStatus, string> = {
  pending_review: 'bg-yellow-100 dark:bg-yellow-500/10 text-yellow-800 dark:text-yellow-400',
  approved: 'bg-blue-100 dark:bg-blue-500/10 text-blue-800 dark:text-blue-400',
  rejected: 'bg-red-100 dark:bg-red-500/10 text-red-700 dark:text-red-400',
  pending_signup: 'bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400',
  active: 'bg-green-100 dark:bg-green-500/10 text-green-800 dark:text-green-400',
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

// Each reviewed field as the owner's request form names it.
const REVIEWED_FIELD_LABELS: Record<FleetMemberReviewedField, string> = {
  fleet_id: 'flota',
  driver_name: 'nombre',
  driver_phone: 'teléfono',
  driver_email: 'email',
  driver_license_number: 'nº de licencia',
  driver_id_number: 'carné de identidad',
  license_doc_path: 'documento de licencia',
};

// fleetService recorded nothing: the invitation changed, was reviewed or was
// removed after this list loaded it.
function invitationChanged(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'FLEET_MEMBER_CHANGED';
}

// Names the reviewed values that differ from the ones the admin acted on.
function changeNotice(shown: FleetMember, current: FleetMember): string {
  const fields = FLEET_MEMBER_REVIEWED_FIELDS.filter((field) => shown[field] !== current[field]);
  return fields.length > 0
    ? `Cambió mientras la revisabas (${fields.map((field) => REVIEWED_FIELD_LABELS[field]).join(', ')}): estos son los datos actuales.`
    : 'Cambió mientras la revisabas: estos son los datos actuales.';
}

export function FleetReview({ corporateAccountId, adminUserId }: Props) {
  const { showToast } = useToast();
  const [fleet, setFleet] = useState<DriverFleet | null>(null);
  const [members, setMembers] = useState<FleetMember[]>([]);
  const [loading, setLoading] = useState(true);
  // Rows whose decision is in flight; each stays busy until its own request settles.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  // The row as it was shown when the admin opened the reject dialog.
  const [rejecting, setRejecting] = useState<FleetMember | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // Rows whose decision was refused because they changed, as they were shown then.
  const [changedRows, setChangedRows] = useState<ReadonlyMap<string, FleetMember>>(() => new Map());

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

  const setBusy = (id: string, busy: boolean) => {
    setBusyIds((prev) => {
      if (prev.has(id) === busy) return prev;
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const forgetChanged = (id: string) => {
    setChangedRows((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  // Show the invitation as it is now and say why nothing was saved.
  const reloadChanged = async (shown: FleetMember) => {
    setChangedRows((prev) => new Map(prev).set(shown.id, shown));
    showToast('warning', 'La invitación cambió o ya no está pendiente, así que no se guardó tu decisión. Revisa los datos actualizados.');
    await fetchData();
  };

  // m is the row as rendered: the service only approves it if it still holds those values.
  const approve = async (m: FleetMember) => {
    setBusy(m.id, true);
    try {
      await fleetService.approveMember(m, adminUserId);
      forgetChanged(m.id);
      showToast('success', 'Conductor aprobado');
      await fetchData();
    } catch (e) {
      if (invitationChanged(e)) await reloadChanged(m);
      else showToast('error', e instanceof Error ? e.message : 'Error al aprobar');
    } finally {
      setBusy(m.id, false);
    }
  };

  const reject = async (m: FleetMember) => {
    if (!rejectReason.trim()) return;
    setBusy(m.id, true);
    try {
      await fleetService.rejectMember(m, adminUserId, rejectReason.trim());
      forgetChanged(m.id);
      showToast('success', 'Conductor rechazado');
      setRejecting(null);
      setRejectReason('');
      await fetchData();
    } catch (e) {
      if (invitationChanged(e)) {
        setRejecting(null);
        await reloadChanged(m);
      } else {
        showToast('error', e instanceof Error ? e.message : 'Error al rechazar');
      }
    } finally {
      setBusy(m.id, false);
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
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 text-sm">
        {/* city is missing from the row while 00602 is not applied */}
        <Meta label="Ciudad" value={fleet.city || '—'} />
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
                    {m.driver_id_number && <div className="text-xs text-ink-muted">CI {m.driver_id_number}</div>}
                  </td>
                  <td className="py-2 pr-2 text-ink-muted">{m.driver_phone}</td>
                  <td className="py-2 pr-2 text-ink-muted">
                    {m.driver_license_number ?? '—'}
                    {m.license_doc_path && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-green-700 dark:text-green-400">doc ✓</span>
                    )}
                  </td>
                  <td className="py-2 pr-2">
                    <span className={`px-2 py-0.5 rounded text-xs ${STATUS_COLORS[m.status]}`}>
                      {STATUS_LABELS[m.status]}
                    </span>
                    {m.rejected_reason && (
                      <div className="text-[11px] text-red-600 dark:text-red-400 mt-1">{m.rejected_reason}</div>
                    )}
                    <ChangeNotice shown={changedRows.get(m.id)} current={m} />
                  </td>
                  <td className="py-2 pr-2">
                    {m.status === 'pending_review' && (
                      <div className="flex gap-2 justify-end">
                        <button
                          className="px-3 py-1 bg-green-600 text-white rounded text-xs disabled:opacity-50"
                          onClick={() => approve(m)}
                          disabled={busyIds.has(m.id)}
                        >
                          Aprobar
                        </button>
                        <button
                          className="px-3 py-1 bg-red-600 text-white rounded text-xs disabled:opacity-50"
                          onClick={() => { setRejecting(m); setRejectReason(''); }}
                          disabled={busyIds.has(m.id)}
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
      {rejecting && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center overflow-y-auto p-4">
          <div role="dialog" aria-modal="true" className="bg-surface-elevated rounded-xl p-6 w-full max-w-md my-auto max-h-[90dvh] overflow-y-auto">
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
                onClick={() => { setRejecting(null); setRejectReason(''); }}
              >
                Cancelar
              </button>
              <button
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg disabled:opacity-50"
                onClick={() => reject(rejecting)}
                disabled={!rejectReason.trim() || busyIds.has(rejecting.id)}
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

function ChangeNotice({ shown, current }: { shown: FleetMember | undefined; current: FleetMember }) {
  if (!shown) return null;
  return <div className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">{changeNotice(shown, current)}</div>;
}

function Meta({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-surface-sunken border rounded-lg p-3">
      <div className="text-[11px] uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="font-medium text-ink mt-0.5">{value}</div>
    </div>
  );
}
