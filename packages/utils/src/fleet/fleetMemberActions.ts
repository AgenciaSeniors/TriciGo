// ============================================================
// TriciGo — what the owner can do with each driver of the fleet
// Plain TypeScript, so vitest can test it without a renderer.
// The label never says more than we know: "Invitación enviada" only
// when a send exists for that number. The sends are matched by the
// phone, not by the row, because deleting a driver and adding them
// again does not reset the server's limits (they count per number).
// ============================================================

import type { CorporateAccountStatus, FleetInviteSend, FleetMember } from '@tricigo/types';
import { normalizeCubanPhone } from '../validation';

/** The server sends at most this many invitations to one number in one fleet (00676). */
export const MAX_INVITE_SENDS_PER_NUMBER = 3;
/** ...and at least this long apart. */
export const MIN_RESEND_GAP_MS = 24 * 60 * 60 * 1000;

export type FleetMemberAction = 'upload_license' | 'resend' | 'reinvite' | 'remove';

export interface FleetMemberLabel {
  /** Key in the driver namespace; `label` is its Spanish default. */
  labelKey: string;
  label: string;
  variant: 'success' | 'warning' | 'error' | 'info' | 'neutral';
}

export interface FleetMemberActions {
  label: FleetMemberLabel;
  /** In the order the row shows them. */
  actions: FleetMemberAction[];
}

const LABELS = {
  pending_review: { labelKey: 'fleet.member_status.pending_review', label: 'Pendiente revisión', variant: 'warning' },
  invited: { labelKey: 'fleet.member_status.invited', label: 'Invitación enviada', variant: 'info' },
  approved: { labelKey: 'fleet.member_status.approved', label: 'Aprobado', variant: 'info' },
  approved_fleet_pending: {
    labelKey: 'fleet.member_status.approved_fleet_pending',
    label: 'Aprobado, falta aprobar la flota',
    variant: 'info',
  },
  active: { labelKey: 'fleet.member_status.active', label: 'Activo', variant: 'success' },
  rejected: { labelKey: 'fleet.member_status.rejected', label: 'Rechazado', variant: 'error' },
  inactive: { labelKey: 'fleet.member_status.inactive', label: 'Inactivo', variant: 'neutral' },
} as const satisfies Record<string, FleetMemberLabel>;

/**
 * The send times for this driver's number, as milliseconds; NaN for a date that
 * does not read. `smsOnly` keeps the channel the server's limits count (00676).
 */
function sendTimes(member: FleetMember, sends: FleetInviteSend[], smsOnly: boolean): number[] {
  const phone = normalizeCubanPhone(member.driver_phone);
  return sends
    .filter((s) => normalizeCubanPhone(s.phone) === phone && (!smsOnly || s.channel === 'sms'))
    .map((s) => Date.parse(s.sent_at));
}

function canResend(times: number[], now: Date): boolean {
  if (times.length >= MAX_INVITE_SENDS_PER_NUMBER) return false;
  if (times.length === 0) return true; // the daily cap may have held the first one back
  if (times.some(Number.isNaN)) return false;
  return now.getTime() - Math.max(...times) >= MIN_RESEND_GAP_MS;
}

/**
 * The status label and the buttons of one driver row.
 * `sends` is null when the read failed: nothing is claimed about it.
 * pending_signup is the same as approved.
 */
export function fleetMemberActions(
  member: FleetMember,
  sends: FleetInviteSend[] | null,
  fleetStatus: CorporateAccountStatus,
  now: Date,
): FleetMemberActions {
  switch (member.status) {
    case 'pending_review':
      return { label: LABELS.pending_review, actions: ['upload_license', 'remove'] };
    case 'active':
      return { label: LABELS.active, actions: ['remove'] };
    case 'rejected':
      return { label: LABELS.rejected, actions: ['reinvite', 'remove'] };
    case 'inactive':
      return { label: LABELS.inactive, actions: ['reinvite', 'remove'] };
    case 'approved':
    case 'pending_signup': {
      // The label says what went to the number by any channel; the limits count SMS only.
      const anySend = sends ? sendTimes(member, sends, false).length > 0 : false;
      const times = sends ? sendTimes(member, sends, true) : null;
      let label: FleetMemberLabel = LABELS.approved;
      if (fleetStatus === 'pending') label = LABELS.approved_fleet_pending;
      else if (anySend) label = LABELS.invited;

      const resend = times !== null && !member.driver_id && fleetStatus === 'approved' && canResend(times, now);
      return { label, actions: resend ? ['resend', 'remove'] : ['remove'] };
    }
  }
}

/** Drivers who already signed up with their number: only `active` counts. */
export function linkedMemberCount(members: FleetMember[]): number {
  return members.filter((m) => m.status === 'active').length;
}

export type FleetActionFailure =
  | 'too_soon'
  | 'limit'
  | 'invite_failed'
  | 'reviewed'
  | 'not_removed'
  | 'exists'
  | 'not_updated'
  | 'failed';

const FAILURE_BY_CODE: Record<string, FleetActionFailure> = {
  FLEET_INVITE_TOO_SOON: 'too_soon',
  FLEET_INVITE_LIMIT: 'limit',
  FLEET_INVITE_FAILED: 'invite_failed',
  FLEET_MEMBER_REVIEWED: 'reviewed',
  FLEET_MEMBER_NOT_REMOVED: 'not_removed',
  FLEET_MEMBER_EXISTS: 'exists',
  FLEET_NOT_UPDATED: 'not_updated',
};

/**
 * Which message a failed owner action gets. The service's own text is a
 * Spanish line or a technical one, so the screens show their translated ones.
 */
export function fleetActionFailure(err: unknown): FleetActionFailure {
  const code = (err as { code?: unknown } | null)?.code;
  return (typeof code === 'string' && FAILURE_BY_CODE[code]) || 'failed';
}
