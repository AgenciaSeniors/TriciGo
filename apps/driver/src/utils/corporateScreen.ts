// ============================================================
// TriciGo Driver — state of the Corporativo screen
// The screen reads the fleets the driver drives for (fleet_members)
// and the fleet they own (driver_fleets). On a bad connection
// either read can fail, so each one is `undefined` until it
// succeeds once: unknown, never "none". The request form shows
// only when both reads succeeded, because a new form session
// creates a new corporate account and would duplicate a fleet the
// owner already has.
//
// Plain TypeScript, so the driver's vitest setup can test it.
// ============================================================

import type { FleetMember, FleetWithMembers } from '@tricigo/types';

export interface CorporateState {
  /** Fleets the driver drives for; `undefined` until a read succeeds. */
  memberships: FleetMember[] | undefined;
  /** The fleet the driver owns, `null` for none; `undefined` until a read succeeds. */
  ownedFleet: FleetWithMembers | null | undefined;
  /** The load whose result applies; any other one is stale. `null` while none runs. */
  load: number | null;
}

/** The screen numbers its loads from 0 and starts load 0 as soon as it can. */
export const initialCorporateState: CorporateState = {
  memberships: undefined,
  ownedFleet: undefined,
  load: 0,
};

export type CorporateAction =
  /** Load `load` started: from now on only its result applies. */
  | { type: 'load_started'; load: number }
  /**
   * The form sent a fleet request and load `load` reads it back. Until then
   * the owned fleet is unknown, so if that read fails the screen shows the
   * error instead of the form it just submitted.
   */
  | { type: 'request_submitted'; load: number }
  /** Load `load` finished. A read that failed keeps the value it had. */
  | {
      type: 'load_settled';
      load: number;
      memberships: PromiseSettledResult<FleetMember[]>;
      ownedFleet: PromiseSettledResult<FleetWithMembers | null>;
    };

export function corporateReducer(state: CorporateState, action: CorporateAction): CorporateState {
  switch (action.type) {
    case 'load_started':
      return { ...state, load: action.load };
    case 'request_submitted':
      return { ...state, ownedFleet: undefined, load: action.load };
    case 'load_settled':
      if (action.load !== state.load) return state;
      return {
        memberships: action.memberships.status === 'fulfilled' ? action.memberships.value : state.memberships,
        ownedFleet: action.ownedFleet.status === 'fulfilled' ? action.ownedFleet.value : state.ownedFleet,
        load: null,
      };
  }
}

export type CorporateView =
  /** A read the screen needs is still on its first load. */
  | { kind: 'loading' }
  /** A read the screen needs has never succeeded: offer a retry. */
  | { kind: 'error' }
  | {
      kind: 'ready';
      /** The owner dashboard. It takes the place of the member card. */
      ownerFleet: FleetWithMembers | null;
      /** The member card: one row per fleet the driver drives for. */
      memberships: FleetMember[];
      /** The driver's fleet request when every one of them was rejected. */
      rejectedRequest: FleetWithMembers | null;
      /** FleetRequestForm. */
      showRequestForm: boolean;
    };

export function deriveCorporateView(state: CorporateState): CorporateView {
  const { memberships, ownedFleet } = state;
  if (ownedFleet) {
    // The dashboard needs only this read: it hides the member card.
    return { kind: 'ready', ownerFleet: ownedFleet, memberships: [], rejectedRequest: null, showRequestForm: false };
  }
  // Every other layout, the request form included, needs both reads.
  if (ownedFleet === undefined || memberships === undefined) {
    return state.load === null ? { kind: 'error' } : { kind: 'loading' };
  }
  return {
    kind: 'ready',
    ownerFleet: null,
    memberships,
    rejectedRequest: null,
    showRequestForm: memberships.length === 0,
  };
}
