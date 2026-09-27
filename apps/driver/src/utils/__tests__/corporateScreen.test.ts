import { describe, it, expect } from 'vitest';
import type { FleetMember, FleetWithMembers } from '@tricigo/types';
import {
  corporateReducer,
  deriveCorporateView,
  fleetStatusBadge,
  initialCorporateState,
  rejectionReason,
  type CorporateState,
} from '../corporateScreen';

const DRIVER = '00000000-0000-4000-8000-000000000011';

function member(overrides: Partial<FleetMember> = {}): FleetMember {
  return {
    id: '00000000-0000-4000-8000-000000000201',
    fleet_id: '00000000-0000-4000-8000-0000000001a1',
    driver_id: DRIVER,
    driver_name: 'Yoel Pérez',
    driver_phone: '+5351234567',
    driver_email: null,
    driver_license_number: null,
    driver_id_number: null,
    status: 'active',
    license_doc_path: null,
    added_at: '2026-09-20T14:00:02+00:00',
    reviewed_at: null,
    reviewed_by: null,
    rejected_reason: null,
    signed_up_at: '2026-09-21T10:00:00+00:00',
    ...overrides,
  };
}

function owned(status: FleetWithMembers['account']['status'], suspendedReason: string | null = null): FleetWithMembers {
  return {
    fleet: {
      id: '00000000-0000-4000-8000-0000000001b1',
      corporate_account_id: '00000000-0000-4000-8000-0000000000b1',
      name: 'TaxiHabana',
      vehicle_count_estimate: 12,
      vehicle_types: ['triciclo_basico'],
      operating_zones: ['Vedado'],
      estimated_rides_per_day_per_vehicle: 8,
      operating_hours_start: '06:00:00',
      operating_hours_end: '22:00:00',
      notes: null,
      created_at: '2026-09-20T14:00:01+00:00',
      updated_at: '2026-09-20T14:00:01+00:00',
    },
    members: [],
    account: {
      id: '00000000-0000-4000-8000-0000000000b1',
      name: 'TaxiHabana',
      status,
      commission_percent: null,
      suspended_reason: suspendedReason,
    },
  };
}

function ok<T>(value: T): PromiseFulfilledResult<T> {
  return { status: 'fulfilled', value };
}

// What Promise.allSettled reports for a lookup that threw on a bad connection.
const failed: PromiseRejectedResult = {
  status: 'rejected',
  reason: new Error('Fleet owner lookup failed: connection failure'),
};

/** Starts load `n` from `state` and lets it settle with these two reads. */
function load(
  state: CorporateState,
  n: number,
  memberships: PromiseSettledResult<FleetMember[]>,
  ownedFleet: PromiseSettledResult<FleetWithMembers | null>,
): CorporateState {
  const started = corporateReducer(state, { type: 'load_started', load: n });
  return corporateReducer(started, { type: 'load_settled', load: n, memberships, ownedFleet });
}

describe('corporateReducer', () => {
  it('applies both reads of the load that settles', () => {
    const m = member();
    expect(load(initialCorporateState, 0, ok([m]), ok(null))).toEqual({
      memberships: [m],
      ownedFleet: null,
      load: null,
    });
  });

  it('leaves a read unknown when it fails before it ever succeeded', () => {
    const state = load(initialCorporateState, 0, failed, failed);

    expect(state.memberships).toBeUndefined();
    expect(state.ownedFleet).toBeUndefined();
    expect(state.load).toBeNull();
  });

  it('keeps the last good value of a read that fails on a later load', () => {
    const m = member();
    const first = load(initialCorporateState, 0, ok([m]), ok(null));

    const second = load(first, 1, failed, ok(owned('pending')));

    expect(second.memberships).toEqual([m]);
    expect(second.ownedFleet).toEqual(owned('pending'));
  });

  it('ignores a load that a newer one replaced', () => {
    // A pull-to-refresh started while the first load was still running, and
    // the first load answered last with older data.
    let state = corporateReducer(initialCorporateState, { type: 'load_started', load: 0 });
    state = corporateReducer(state, { type: 'load_started', load: 1 });
    state = corporateReducer(state, { type: 'load_settled', load: 1, memberships: ok([]), ownedFleet: ok(owned('pending')) });
    state = corporateReducer(state, { type: 'load_settled', load: 0, memberships: ok([]), ownedFleet: ok(null) });

    expect(state.ownedFleet).toEqual(owned('pending'));
  });

  it('forgets the owned fleet once a request is submitted, until the load that reads it back', () => {
    const shown = load(initialCorporateState, 0, ok([]), ok(null));

    expect(corporateReducer(shown, { type: 'request_submitted', load: 1 })).toEqual({
      memberships: [],
      ownedFleet: undefined,
      load: 1,
    });
  });

  it('shows an error, not the form it just submitted, when the read-back fails', () => {
    let state = load(initialCorporateState, 0, ok([]), ok(null));
    state = corporateReducer(state, { type: 'request_submitted', load: 1 });
    state = corporateReducer(state, { type: 'load_settled', load: 1, memberships: ok([]), ownedFleet: failed });

    expect(deriveCorporateView(state)).toEqual({ kind: 'error' });
  });

  it('does not let a load that started before the submission bring the form back', () => {
    let state = load(initialCorporateState, 0, ok([]), ok(null));
    state = corporateReducer(state, { type: 'load_started', load: 1 });
    state = corporateReducer(state, { type: 'request_submitted', load: 2 });

    // The refresh answers with what it read before the request existed.
    state = corporateReducer(state, { type: 'load_settled', load: 1, memberships: ok([]), ownedFleet: ok(null) });
    expect(deriveCorporateView(state)).toEqual({ kind: 'loading' });

    state = corporateReducer(state, { type: 'load_settled', load: 2, memberships: ok([]), ownedFleet: ok(owned('pending')) });
    expect(deriveCorporateView(state)).toMatchObject({ kind: 'ready', ownerFleet: owned('pending'), showRequestForm: false });
  });
});

describe('deriveCorporateView', () => {
  it('shows the skeleton while the first load runs', () => {
    expect(deriveCorporateView(initialCorporateState)).toEqual({ kind: 'loading' });
  });

  it('shows an error, not the request form, when the first load fails', () => {
    expect(deriveCorporateView(load(initialCorporateState, 0, failed, failed))).toEqual({ kind: 'error' });
  });

  it('shows an error when only the owned fleet could not be read, even with no memberships', () => {
    // The owner may have a fleet: a new form would create a second one.
    expect(deriveCorporateView(load(initialCorporateState, 0, ok([]), failed))).toEqual({ kind: 'error' });
  });

  it('shows an error when the memberships could not be read and the driver owns no fleet', () => {
    expect(deriveCorporateView(load(initialCorporateState, 0, failed, ok(null)))).toEqual({ kind: 'error' });
  });

  it('shows the owner dashboard even when the memberships could not be read', () => {
    expect(deriveCorporateView(load(initialCorporateState, 0, failed, ok(owned('approved'))))).toEqual({
      kind: 'ready',
      ownerFleet: owned('approved'),
      memberships: [],
      rejectedRequest: null,
      showRequestForm: false,
    });
  });

  it('shows the request form only when both reads found nothing', () => {
    expect(deriveCorporateView(load(initialCorporateState, 0, ok([]), ok(null)))).toEqual({
      kind: 'ready',
      ownerFleet: null,
      memberships: [],
      rejectedRequest: null,
      showRequestForm: true,
    });
  });

  it('shows the fleets the driver drives for instead of the request form', () => {
    const m = member();
    expect(deriveCorporateView(load(initialCorporateState, 0, ok([m]), ok(null)))).toEqual({
      kind: 'ready',
      ownerFleet: null,
      memberships: [m],
      rejectedRequest: null,
      showRequestForm: false,
    });
  });

  it('keeps the owner dashboard ahead of the member card', () => {
    const view = deriveCorporateView(load(initialCorporateState, 0, ok([member()]), ok(owned('approved'))));

    expect(view).toMatchObject({ kind: 'ready', ownerFleet: owned('approved'), memberships: [] });
  });

  it('keeps the owner dashboard when a later refresh fails', () => {
    const shown = load(initialCorporateState, 0, ok([]), ok(owned('approved')));

    expect(deriveCorporateView(load(shown, 1, failed, failed))).toMatchObject({ kind: 'ready', ownerFleet: owned('approved') });
  });

  it('keeps showing what it knows while a refresh runs', () => {
    const shown = load(initialCorporateState, 0, ok([]), ok(null));
    const refreshing = corporateReducer(shown, { type: 'load_started', load: 1 });

    expect(deriveCorporateView(refreshing)).toMatchObject({ kind: 'ready', showRequestForm: true });
  });

  it('shows the skeleton while it retries after an error', () => {
    const errored = load(initialCorporateState, 0, failed, failed);

    expect(deriveCorporateView(corporateReducer(errored, { type: 'load_started', load: 1 }))).toEqual({ kind: 'loading' });
  });

  describe('when every fleet request of the driver was rejected', () => {
    // getFleetByOwner ranks rejected last, so it returns a rejected fleet
    // only when the driver has no approved, pending or suspended one.
    it('shows the rejected request and the form to send it again, not a dashboard', () => {
      const rejected = owned('rejected', 'Faltan las licencias de los conductores');

      expect(deriveCorporateView(load(initialCorporateState, 0, ok([]), ok(rejected)))).toEqual({
        kind: 'ready',
        ownerFleet: null,
        memberships: [],
        rejectedRequest: rejected,
        showRequestForm: true,
      });
    });

    it('lists the fleets the driver drives for above the rejected request and its form', () => {
      const m = member();

      expect(deriveCorporateView(load(initialCorporateState, 0, ok([m]), ok(owned('rejected'))))).toEqual({
        kind: 'ready',
        ownerFleet: null,
        memberships: [m],
        rejectedRequest: owned('rejected'),
        showRequestForm: true,
      });
    });

    it('shows an error when the memberships could not be read', () => {
      expect(deriveCorporateView(load(initialCorporateState, 0, failed, ok(owned('rejected'))))).toEqual({ kind: 'error' });
    });
  });

  it('keeps a suspended fleet as the dashboard', () => {
    expect(deriveCorporateView(load(initialCorporateState, 0, ok([]), ok(owned('suspended'))))).toMatchObject({
      kind: 'ready',
      ownerFleet: owned('suspended'),
      rejectedRequest: null,
      showRequestForm: false,
    });
  });
});

describe('fleetStatusBadge', () => {
  // Feminine, like "la flota" next to it, instead of the raw account status.
  it.each([
    ['pending', 'En revisión', 'warning'],
    ['approved', 'Aprobada', 'success'],
    ['suspended', 'Suspendida', 'error'],
    ['rejected', 'Rechazada', 'error'],
  ] as const)('labels the %s status "%s"', (status, label, variant) => {
    expect(fleetStatusBadge(status)).toEqual({ labelKey: `fleet.status.${status}`, label, variant });
  });
});

describe('rejectionReason', () => {
  it('returns the reason the admin wrote, trimmed', () => {
    expect(rejectionReason('  Faltan las licencias de los conductores\n')).toBe('Faltan las licencias de los conductores');
  });

  it('returns null when the admin wrote no reason', () => {
    // The admin's reject dialog does not require one.
    expect(rejectionReason(null)).toBeNull();
    expect(rejectionReason('')).toBeNull();
    expect(rejectionReason('   ')).toBeNull();
  });
});
