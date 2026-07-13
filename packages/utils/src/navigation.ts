/**
 * Pure turn-by-turn navigation helpers, extracted from the driver app's
 * `useInAppNavigation` hook so they can be unit-tested without React Native.
 *
 * Two responsibilities:
 *   1. Build the Spanish text-to-speech sentence for a maneuver
 *      (`buildSpokenInstruction` / `buildSpokenInstructionWithDistance`).
 *      Cuban market is Spanish-first, so the spoken text is hardcoded ES,
 *      decoupled from i18n (the on-screen label still uses i18n via
 *      `getManeuverLabel` in the hook).
 *   2. Project each maneuver onto the route polyline to know its
 *      distance-along-route (`computeManeuverAlongDistances`), so step
 *      tracking uses arc-length instead of straight-line distance to a
 *      point — which mis-fires on Cuba's dense parallel-street grid.
 */
import { projectPointOnPolyline, type NavigationStep, type GeoPoint } from './geo';

/** Uppercase the first character of a phrase. */
function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** 'izquierda' / 'derecha' from an OSRM/Mapbox modifier, or null if none. */
function sideOf(modifier: string): 'izquierda' | 'derecha' | null {
  if (modifier.includes('left')) return 'izquierda';
  if (modifier.includes('right')) return 'derecha';
  return null;
}

/**
 * Plain turn phrase from a modifier ("gira a la derecha", "continúa recto"),
 * lowercase and without street. Returns null for an unknown/blank modifier so
 * the caller can avoid falsely asserting "continúa recto" on a real turn.
 */
function directionCore(modifier: string): string | null {
  switch (modifier) {
    case 'left': return 'gira a la izquierda';
    case 'sharp left': return 'gira cerrado a la izquierda';
    case 'slight left': return 'gira ligeramente a la izquierda';
    case 'right': return 'gira a la derecha';
    case 'sharp right': return 'gira cerrado a la derecha';
    case 'slight right': return 'gira ligeramente a la derecha';
    case 'uturn': return 'haz un giro en U';
    case 'straight': return 'continúa recto';
    default: return null;
  }
}

/**
 * Core maneuver phrase (lowercase, no leading capital, no distance prefix),
 * branching on `maneuver_type` FIRST so roundabouts/forks/merges/ramps read
 * correctly instead of collapsing to a plain turn. `arrive`/`depart` are
 * handled by the public builders, not here.
 */
function describeManeuver(step: NavigationStep): string {
  const { maneuver_type: type, maneuver_modifier: mod, name } = step;
  const street = name?.trim();
  const onStreet = street ? ` por ${street}` : '';
  const side = sideOf(mod);

  switch (type) {
    case 'roundabout':
    case 'rotary': {
      if (step.maneuver_exit != null && step.maneuver_exit > 0) {
        return street
          ? `en la rotonda, toma la salida ${step.maneuver_exit} hacia ${street}`
          : `en la rotonda, toma la salida ${step.maneuver_exit}`;
      }
      return side ? `en la rotonda, gira a la ${side}${onStreet}` : `en la rotonda, continúa${onStreet}`;
    }
    case 'fork':
      return side ? `mantente a la ${side}${onStreet}` : `continúa${onStreet}`;
    case 'merge':
      return side ? `incorpórate a la ${side}${onStreet}` : `incorpórate${onStreet}`;
    case 'end of road':
      return side ? `al final de la calle, gira a la ${side}${onStreet}` : `continúa${onStreet}`;
    case 'on ramp':
    case 'off ramp':
      return side ? `toma la salida a la ${side}${onStreet}` : `toma la salida${onStreet}`;
    case 'new name':
    case 'notification':
      // Road just changed name — no action, keep going.
      return `continúa${onStreet}`;
    default: {
      const core = directionCore(mod);
      if (core) return `${core}${onStreet}`;
      // Unknown/blank modifier on a real turn: DON'T assert "continúa recto".
      return street ? `continúa por ${street}` : 'continúa';
    }
  }
}

/**
 * Plain-Spanish sentence for text-to-speech from a NavigationStep. Used for
 * the depart announce, the 50 m imminent announce, and arrival.
 */
export function buildSpokenInstruction(step: NavigationStep): string {
  const { maneuver_type: type, name } = step;
  const street = name?.trim();

  if (type === 'arrive') {
    return step.waypoint_index != null
      ? `Llegaste a la Parada ${step.waypoint_index + 1}`
      : 'Llegaste a tu destino';
  }
  if (type === 'depart') {
    return street ? `Dirígete por ${street}` : 'Inicia el recorrido';
  }
  return capitalize(describeManeuver(step));
}

/**
 * Distance-prefixed variant ("En 200 metros, gira a la derecha por Calle X").
 * Used for the 200 m pre-announce.
 */
export function buildSpokenInstructionWithDistance(step: NavigationStep, distance_m: number): string {
  const { maneuver_type: type } = step;
  const distText = `En ${distance_m} metros`;

  if (type === 'arrive') {
    return step.waypoint_index != null
      ? `${distText} llegarás a la Parada ${step.waypoint_index + 1}`
      : `${distText} llegarás a tu destino`;
  }
  return `${distText}, ${describeManeuver(step)}`;
}

/**
 * For each navigation step, project its `maneuver_location` onto the route
 * polyline and return the distance-along-route (arc-length, meters) of that
 * maneuver. Enforces a monotonic non-decreasing result: maneuvers are in
 * route order, so a later maneuver can never be "before" an earlier one —
 * this defends against a self-crossing route projecting a point onto the
 * wrong segment.
 *
 * @param routeCoordinates full route geometry as [lat, lng] pairs
 * @param steps navigation steps (in order)
 * @returns arc-length in meters for each step's maneuver
 */
export function computeManeuverAlongDistances(
  routeCoordinates: [number, number][],
  steps: NavigationStep[],
): number[] {
  if (routeCoordinates.length < 2) return steps.map(() => 0);
  const polyline: GeoPoint[] = routeCoordinates.map(([lat, lng]) => ({ latitude: lat, longitude: lng }));

  let prev = 0;
  return steps.map((step) => {
    const m = step.maneuver_location;
    if (!m || !Number.isFinite(m[0]) || !Number.isFinite(m[1])) {
      return prev; // unknown point → keep previous (don't jump the tracker)
    }
    const along = projectPointOnPolyline({ latitude: m[0], longitude: m[1] }, polyline).distanceAlongRouteM;
    prev = Math.max(prev, along);
    return prev;
  });
}
