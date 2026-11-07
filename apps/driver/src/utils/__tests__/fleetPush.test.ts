import { describe, it, expect } from 'vitest';
import { FLEET_UPDATE_ROUTE, fleetUpdateRoute } from '../fleetPush';

describe('fleetUpdateRoute (driver app)', () => {
  it('opens Corporativo for a fleet_update push', () => {
    expect(fleetUpdateRoute({ type: 'fleet_update', event: 'added_to_fleet' })).toBe('/profile/corporate');
    expect(FLEET_UPDATE_ROUTE).toBe('/profile/corporate');
  });

  it('ignores every other push and malformed data', () => {
    expect(fleetUpdateRoute({ type: 'system' })).toBeNull();
    expect(fleetUpdateRoute({ type: 'ride_offer', ride_id: 'r-1' })).toBeNull();
    expect(fleetUpdateRoute({ event: 'fleet_update' })).toBeNull();
    expect(fleetUpdateRoute(undefined)).toBeNull();
    expect(fleetUpdateRoute(null)).toBeNull();
    expect(fleetUpdateRoute('fleet_update')).toBeNull();
  });
});
