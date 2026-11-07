import { describe, it, expect } from 'vitest';
import { FLEET_UPDATE_ROUTE, fleetUpdateRoute } from '../fleetPush';

describe('fleetUpdateRoute (passenger app)', () => {
  it('opens Flota for a fleet_update push', () => {
    expect(fleetUpdateRoute({ type: 'fleet_update', event: 'fleet_approved' })).toBe('/profile/fleet');
    expect(FLEET_UPDATE_ROUTE).toBe('/profile/fleet');
  });

  it('ignores every other push and malformed data', () => {
    expect(fleetUpdateRoute({ type: 'system' })).toBeNull();
    expect(fleetUpdateRoute({ type: 'chat', ride_id: 'r-1' })).toBeNull();
    expect(fleetUpdateRoute({ event: 'fleet_update' })).toBeNull();
    expect(fleetUpdateRoute(undefined)).toBeNull();
    expect(fleetUpdateRoute(null)).toBeNull();
    expect(fleetUpdateRoute(42)).toBeNull();
  });
});
