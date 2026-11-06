import { describe, it, expect } from 'vitest';
import type { FleetInviteSend, FleetMember } from '@tricigo/types';
import {
  fleetActionFailure,
  fleetMemberActions,
  linkedMemberCount,
  MAX_INVITE_SENDS_PER_NUMBER,
  MIN_RESEND_GAP_MS,
} from '../fleetMemberActions';

const NOW = new Date('2026-11-06T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function member(overrides: Partial<FleetMember> = {}): FleetMember {
  return {
    id: '00000000-0000-4000-8000-000000000201',
    fleet_id: '00000000-0000-4000-8000-0000000001a1',
    driver_id: null,
    driver_name: 'Yoel Pérez',
    driver_phone: '+5351234567',
    driver_email: null,
    driver_license_number: null,
    driver_id_number: null,
    status: 'pending_review',
    license_doc_path: null,
    added_at: '2026-11-01T10:00:00Z',
    reviewed_at: null,
    reviewed_by: null,
    rejected_reason: null,
    ...overrides,
  } as FleetMember;
}

let sendId = 1;
function send(hoursAgo: number, overrides: Partial<FleetInviteSend> = {}): FleetInviteSend {
  return {
    id: sendId++,
    fleet_id: '00000000-0000-4000-8000-0000000001a1',
    phone: '+5351234567',
    member_id: '00000000-0000-4000-8000-000000000201',
    channel: 'sms',
    source: 'review',
    sent_at: new Date(NOW.getTime() - hoursAgo * HOUR).toISOString(),
    ...overrides,
  };
}

describe('fleetMemberActions: the table of the brief', () => {
  it('pending_review: label, upload licence and remove', () => {
    const r = fleetMemberActions(member({ status: 'pending_review' }), [], 'pending', NOW);
    expect(r.label).toMatchObject({ label: 'Pendiente revisión', labelKey: 'fleet.member_status.pending_review' });
    expect(r.actions).toEqual(['upload_license', 'remove']);
  });

  it('approved and unlinked, sent once 30 h ago, approved company: resend and remove', () => {
    const r = fleetMemberActions(member({ status: 'approved' }), [send(30)], 'approved', NOW);
    expect(r.label.label).toBe('Invitación enviada');
    expect(r.actions).toEqual(['resend', 'remove']);
  });

  it('active: remove only', () => {
    const r = fleetMemberActions(member({ status: 'active', driver_id: 'd1' }), [send(30)], 'approved', NOW);
    expect(r.label.label).toBe('Activo');
    expect(r.actions).toEqual(['remove']);
  });

  it.each([
    ['rejected', 'Rechazado'],
    ['inactive', 'Inactivo'],
  ] as const)('%s: invite again and remove', (status, label) => {
    const r = fleetMemberActions(member({ status }), [], 'approved', NOW);
    expect(r.label.label).toBe(label);
    expect(r.actions).toEqual(['reinvite', 'remove']);
  });
});

describe('fleetMemberActions: decision 1, pending_signup is approved', () => {
  it('gets the same label and actions as approved', () => {
    const sends = [send(30)];
    const a = fleetMemberActions(member({ status: 'approved' }), sends, 'approved', NOW);
    const b = fleetMemberActions(member({ status: 'pending_signup' }), sends, 'approved', NOW);
    expect(b).toEqual(a);
  });
});

describe('fleetMemberActions: decision 2, the label tells the truth', () => {
  it('does not say "Invitación enviada" with no send for that number', () => {
    const r = fleetMemberActions(member({ status: 'approved' }), [], 'approved', NOW);
    expect(r.label.label).toBe('Aprobado');
  });

  it('says the company is missing its approval', () => {
    const r = fleetMemberActions(member({ status: 'approved' }), [], 'pending', NOW);
    expect(r.label.label).toBe('Aprobado, falta aprobar la flota');
    expect(r.label.labelKey).toBe('fleet.member_status.approved_fleet_pending');
  });

  it('does not say "Invitación enviada" when the sends are unknown', () => {
    const r = fleetMemberActions(member({ status: 'approved' }), null, 'approved', NOW);
    expect(r.label.label).toBe('Aprobado');
  });

  it('does not say "Invitación enviada" for a send to another number', () => {
    const r = fleetMemberActions(member({ status: 'approved' }), [send(30, { phone: '+5352222222' })], 'approved', NOW);
    expect(r.label.label).toBe('Aprobado');
  });
});

describe('fleetMemberActions: decision 3, when "Reenviar" shows', () => {
  const approved = () => member({ status: 'approved' });

  it('waits 24 h after the last send, to the millisecond', () => {
    const justUnder = [{ ...send(0), sent_at: new Date(NOW.getTime() - MIN_RESEND_GAP_MS + 1).toISOString() }];
    const exactly = [{ ...send(0), sent_at: new Date(NOW.getTime() - MIN_RESEND_GAP_MS).toISOString() }];
    expect(fleetMemberActions(approved(), justUnder, 'approved', NOW).actions).not.toContain('resend');
    expect(fleetMemberActions(approved(), exactly, 'approved', NOW).actions).toContain('resend');
  });

  it('uses the newest send whatever the order of the list', () => {
    const sends = [send(48), send(2), send(30)];
    expect(fleetMemberActions(approved(), sends, 'approved', NOW).actions).not.toContain('resend');
  });

  it('stops at the third send', () => {
    expect(MAX_INVITE_SENDS_PER_NUMBER).toBe(3);
    const two = [send(100), send(80)];
    const three = [send(100), send(80), send(60)];
    expect(fleetMemberActions(approved(), two, 'approved', NOW).actions).toContain('resend');
    expect(fleetMemberActions(approved(), three, 'approved', NOW).actions).not.toContain('resend');
  });

  it('counts sends by number, so deleting and adding the driver again does not reset it', () => {
    const readded = member({ status: 'approved', id: '00000000-0000-4000-8000-0000000002ff' });
    const sends = [send(100), send(80), send(60)]; // all for the old row id
    expect(fleetMemberActions(readded, sends, 'approved', NOW).actions).not.toContain('resend');
  });

  it('matches the number however it is written', () => {
    const local = member({ status: 'approved', driver_phone: '51234567' });
    const sends = [send(100), send(80), send(60)];
    expect(fleetMemberActions(local, sends, 'approved', NOW).actions).not.toContain('resend');
    expect(fleetMemberActions(local, sends, 'approved', NOW).label.label).toBe('Invitación enviada');
  });

  it('shows it with no send yet, because the daily cap may have held the first one back', () => {
    expect(fleetMemberActions(approved(), [], 'approved', NOW).actions).toEqual(['resend', 'remove']);
  });

  it('does not show it while the company is not approved', () => {
    expect(fleetMemberActions(approved(), [send(30)], 'pending', NOW).actions).toEqual(['remove']);
    expect(fleetMemberActions(approved(), [send(30)], 'suspended', NOW).actions).toEqual(['remove']);
  });

  it('does not show it when the row is already linked', () => {
    const linked = member({ status: 'approved', driver_id: 'd1' });
    expect(fleetMemberActions(linked, [send(30)], 'approved', NOW).actions).toEqual(['remove']);
  });

  it('does not show it for a send read that failed (decision 4)', () => {
    expect(fleetMemberActions(approved(), null, 'approved', NOW).actions).toEqual(['remove']);
  });

  it('does not show it when a send has an unreadable date', () => {
    const bad = [send(0, { sent_at: 'not a date' })];
    expect(fleetMemberActions(approved(), bad, 'approved', NOW).actions).not.toContain('resend');
  });

  // The server counts channel = 'sms' only (00676): a push does not use up the cap or the gap.
  it('a push to the number does not hide "Reenviar"', () => {
    const pushes = [send(100, { channel: 'push' }), send(80, { channel: 'push' }), send(60, { channel: 'push' })];
    expect(fleetMemberActions(approved(), pushes, 'approved', NOW).actions).toContain('resend');
  });

  it('a push 2 h ago does not hold the 24 h gap', () => {
    const r = fleetMemberActions(approved(), [send(2, { channel: 'push' })], 'approved', NOW);
    expect(r.actions).toContain('resend');
  });

  it('the SMS sends still hit the cap and the gap when pushes are mixed in', () => {
    const mixed = [send(100), send(80, { channel: 'push' }), send(60)];
    expect(fleetMemberActions(approved(), mixed, 'approved', NOW).actions).toContain('resend');
    const capped = [send(100), send(80), send(60), send(50, { channel: 'push' })];
    expect(fleetMemberActions(approved(), capped, 'approved', NOW).actions).not.toContain('resend');
    const soon = [send(100), send(2)];
    expect(fleetMemberActions(approved(), soon, 'approved', NOW).actions).not.toContain('resend');
  });

  it('the label stays "Invitación enviada" when only a push went to the number', () => {
    const r = fleetMemberActions(approved(), [send(5, { channel: 'push' })], 'approved', NOW);
    expect(r.label.label).toBe('Invitación enviada');
  });
});

describe('fleetMemberActions: licence only while pending_review', () => {
  it.each(['approved', 'pending_signup', 'active', 'rejected', 'inactive'] as const)('%s has no licence button', (status) => {
    const r = fleetMemberActions(member({ status }), [send(30)], 'approved', NOW);
    expect(r.actions).not.toContain('upload_license');
  });
});

describe('linkedMemberCount', () => {
  it('counts only active, not approved', () => {
    const members = [
      member({ id: 'a', status: 'active' }),
      member({ id: 'b', status: 'approved' }),
      member({ id: 'c', status: 'pending_signup' }),
      member({ id: 'd', status: 'active' }),
    ];
    expect(linkedMemberCount(members)).toBe(2);
  });
});

describe('fleetActionFailure', () => {
  const coded = (code: string) => Object.assign(new Error('x'), { code });
  it.each([
    ['FLEET_INVITE_TOO_SOON', 'too_soon'],
    ['FLEET_INVITE_LIMIT', 'limit'],
    ['FLEET_INVITE_FAILED', 'invite_failed'],
    ['FLEET_MEMBER_REVIEWED', 'reviewed'],
    ['FLEET_MEMBER_NOT_REMOVED', 'not_removed'],
    ['FLEET_MEMBER_EXISTS', 'exists'],
    ['FLEET_NOT_UPDATED', 'not_updated'],
  ] as const)('%s is %s', (code, kind) => {
    expect(fleetActionFailure(coded(code))).toBe(kind);
  });

  it('is "failed" for anything else', () => {
    expect(fleetActionFailure(new Error('boom'))).toBe('failed');
    expect(fleetActionFailure(null)).toBe('failed');
  });
});
