import { describe, it, expect } from 'vitest';
import {
  buildSpokenInstruction,
  buildSpokenInstructionWithDistance,
  computeManeuverAlongDistances,
} from '../navigation';
import type { NavigationStep } from '../geo';

/** Build a NavigationStep with sensible defaults for tests. */
function mk(partial: Partial<NavigationStep>): NavigationStep {
  return {
    distance_m: 100,
    duration_s: 30,
    name: '',
    maneuver_type: 'turn',
    maneuver_modifier: '',
    maneuver_location: [23.13, -82.38],
    geometry: [],
    ...partial,
  };
}

describe('buildSpokenInstruction — backward compatibility (existing behavior)', () => {
  it('turn right with street', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'turn', maneuver_modifier: 'right', name: 'Calle 23' })))
      .toBe('Gira a la derecha por Calle 23');
  });

  it('turn left without street', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'turn', maneuver_modifier: 'left', name: '' })))
      .toBe('Gira a la izquierda');
  });

  it('uturn', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'turn', maneuver_modifier: 'uturn' })))
      .toBe('Haz un giro en U');
  });

  it('straight with street keeps "recto"', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'continue', maneuver_modifier: 'straight', name: 'Malecón' })))
      .toBe('Continúa recto por Malecón');
  });

  it('arrive at destination', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'arrive', maneuver_modifier: '' })))
      .toBe('Llegaste a tu destino');
  });

  it('arrive at a passenger stop', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'arrive', waypoint_index: 0 })))
      .toBe('Llegaste a la Parada 1');
  });

  it('depart with street', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'depart', name: 'Reina' })))
      .toBe('Dirígete por Reina');
  });

  it('depart without street', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'depart', name: '' })))
      .toBe('Inicia el recorrido');
  });
});

describe('buildSpokenInstruction — maneuver_type handling (Bug 3)', () => {
  it('roundabout with exit number', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'roundabout', maneuver_modifier: 'right', maneuver_exit: 2, name: 'Paseo' })))
      .toBe('En la rotonda, toma la salida 2 hacia Paseo');
  });

  it('roundabout without exit falls back to a side', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'rotary', maneuver_modifier: 'left', name: '' })))
      .toBe('En la rotonda, gira a la izquierda');
  });

  it('fork keeps you on a side', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'fork', maneuver_modifier: 'slight right', name: 'Vía Blanca' })))
      .toBe('Mantente a la derecha por Vía Blanca');
  });

  it('merge', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'merge', maneuver_modifier: 'left' })))
      .toBe('Incorpórate a la izquierda');
  });

  it('end of road', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'end of road', maneuver_modifier: 'right', name: 'Línea' })))
      .toBe('Al final de la calle, gira a la derecha por Línea');
  });

  it('on ramp', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'on ramp', maneuver_modifier: 'right', name: 'Autopista' })))
      .toBe('Toma la salida a la derecha por Autopista');
  });

  it('new name does NOT say "recto"', () => {
    expect(buildSpokenInstruction(mk({ maneuver_type: 'new name', maneuver_modifier: 'straight', name: 'Avenida' })))
      .toBe('Continúa por Avenida');
  });

  it('a turn with a BLANK modifier does NOT assert "Continúa recto" (Bug 3)', () => {
    const withStreet = buildSpokenInstruction(mk({ maneuver_type: 'turn', maneuver_modifier: '', name: 'Calle G' }));
    expect(withStreet).toBe('Continúa por Calle G');
    expect(withStreet).not.toContain('recto');

    const noStreet = buildSpokenInstruction(mk({ maneuver_type: 'turn', maneuver_modifier: '', name: '' }));
    expect(noStreet).toBe('Continúa');
    expect(noStreet).not.toContain('recto');
  });
});

describe('buildSpokenInstructionWithDistance', () => {
  it('prefixes the distance for a normal turn', () => {
    expect(buildSpokenInstructionWithDistance(mk({ maneuver_type: 'turn', maneuver_modifier: 'right', name: 'Calle 23' }), 200))
      .toBe('En 200 metros, gira a la derecha por Calle 23');
  });

  it('arrive at destination with distance', () => {
    expect(buildSpokenInstructionWithDistance(mk({ maneuver_type: 'arrive' }), 150))
      .toBe('En 150 metros llegarás a tu destino');
  });

  it('roundabout with exit and distance', () => {
    expect(buildSpokenInstructionWithDistance(mk({ maneuver_type: 'roundabout', maneuver_exit: 3, name: 'Paseo' }), 120))
      .toBe('En 120 metros, en la rotonda, toma la salida 3 hacia Paseo');
  });
});

describe('computeManeuverAlongDistances', () => {
  // A straight east–west route at latitude 23.13. 0.001° lng ≈ 102.4 m here.
  const routeCoords: [number, number][] = [
    [23.13, -82.380],
    [23.13, -82.379],
    [23.13, -82.378],
  ];

  it('returns the arc-length (distance-along-route) of each maneuver point, monotonic', () => {
    const steps: NavigationStep[] = [
      mk({ maneuver_type: 'depart', maneuver_location: [23.13, -82.380] }),
      mk({ maneuver_type: 'turn', maneuver_location: [23.13, -82.379] }),
      mk({ maneuver_type: 'arrive', maneuver_location: [23.13, -82.378] }),
    ];
    const along = computeManeuverAlongDistances(routeCoords, steps);
    expect(along).toHaveLength(3);
    expect(along[0]).toBeCloseTo(0, 0);
    expect(along[1]).toBeGreaterThan(95);
    expect(along[1]).toBeLessThan(110);
    expect(along[2]).toBeGreaterThan(200);
    // Monotonic non-decreasing.
    expect(along[1]).toBeGreaterThanOrEqual(along[0]!);
    expect(along[2]).toBeGreaterThanOrEqual(along[1]!);
  });

  it('clamps out-of-order maneuver projections to be non-decreasing (defensive)', () => {
    // maneuver 0 projects to the middle, maneuver 1 to the start (out of order).
    const steps: NavigationStep[] = [
      mk({ maneuver_location: [23.13, -82.379] }), // ~102 m along
      mk({ maneuver_location: [23.13, -82.380] }), // ~0 m along
    ];
    const along = computeManeuverAlongDistances(routeCoords, steps);
    expect(along[1]).toBeGreaterThanOrEqual(along[0]!);
  });

  it('is safe on a degenerate (single-point) route', () => {
    const steps: NavigationStep[] = [mk({}), mk({})];
    expect(computeManeuverAlongDistances([[23.13, -82.38]], steps)).toEqual([0, 0]);
  });
});
