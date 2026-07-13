import { describe, it, expect } from 'vitest';
import { parseNavigationRoute } from '../geo';

/**
 * Synthetic Directions route (Mapbox/OSRM share this shape with
 * `geometries=geojson&steps=true`). Coordinates are [lng, lat].
 */
describe('parseNavigationRoute', () => {
  it('captures the roundabout exit number into maneuver_exit', () => {
    const route = {
      geometry: { coordinates: [[-82.380, 23.13], [-82.379, 23.13], [-82.378, 23.13]] as [number, number][] },
      distance: 205,
      duration: 60,
      legs: [
        {
          steps: [
            {
              distance: 0, duration: 0, name: 'Reina',
              geometry: { coordinates: [[-82.380, 23.13]] },
              maneuver: { type: 'depart', modifier: '', location: [-82.380, 23.13] },
            },
            {
              distance: 102, duration: 30, name: 'Paseo',
              geometry: { coordinates: [[-82.379, 23.13]] },
              maneuver: { type: 'roundabout', modifier: 'right', exit: 2, location: [-82.379, 23.13] },
            },
            {
              distance: 103, duration: 30, name: '',
              geometry: { coordinates: [[-82.378, 23.13]] },
              maneuver: { type: 'arrive', modifier: '', location: [-82.378, 23.13] },
            },
          ],
        },
      ],
    };

    const parsed = parseNavigationRoute(route);
    expect(parsed).not.toBeNull();
    expect(parsed!.steps).toHaveLength(3);
    expect(parsed!.steps[1]!.maneuver_type).toBe('roundabout');
    expect(parsed!.steps[1]!.maneuver_exit).toBe(2);
    // Non-roundabout steps have no exit.
    expect(parsed!.steps[0]!.maneuver_exit).toBeUndefined();
    expect(parsed!.steps[2]!.maneuver_exit).toBeUndefined();
    // Coordinates flipped [lng,lat] → [lat,lng].
    expect(parsed!.steps[1]!.maneuver_location).toEqual([23.13, -82.379]);
  });
});
