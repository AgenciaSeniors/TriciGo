import { describe, expect, it } from 'vitest';
import { computeBounds, MIN_BOUNDS_SPAN_DEG } from '../mapBounds';

// The service picker fits the map to pickup and destination. With only the
// destination (the pickup still missing, first emulator round 2026-11-17)
// the box had no area and Mapbox fitted it at zoom 25.5: an all-gray map.

const CAPITOLIO: [number, number] = [-82.3597, 23.1352];
const NACIONAL: [number, number] = [-82.3810, 23.1430];

const span = (b: { ne: [number, number]; sw: [number, number] }) => ({
  lng: b.ne[0] - b.sw[0],
  lat: b.ne[1] - b.sw[1],
});

describe('computeBounds', () => {
  it('gives a single point a box around it instead of no area', () => {
    const bounds = computeBounds([CAPITOLIO]);
    expect(bounds).not.toBeNull();
    expect(span(bounds!).lng).toBeCloseTo(MIN_BOUNDS_SPAN_DEG, 9);
    expect(span(bounds!).lat).toBeCloseTo(MIN_BOUNDS_SPAN_DEG, 9);
    // Centred on the point.
    expect((bounds!.ne[0] + bounds!.sw[0]) / 2).toBeCloseTo(CAPITOLIO[0], 9);
    expect((bounds!.ne[1] + bounds!.sw[1]) / 2).toBeCloseTo(CAPITOLIO[1], 9);
  });

  it('keeps a trip larger than the minimum exactly as it is', () => {
    expect(computeBounds([CAPITOLIO, NACIONAL])).toEqual({
      ne: [CAPITOLIO[0], NACIONAL[1]],
      sw: [NACIONAL[0], CAPITOLIO[1]],
    });
  });

  it('widens only the side that is too thin', () => {
    const north: [number, number] = [CAPITOLIO[0], CAPITOLIO[1] + 0.02];
    const bounds = computeBounds([CAPITOLIO, north])!;
    expect(span(bounds).lat).toBeCloseTo(0.02, 9);
    expect(span(bounds).lng).toBeCloseTo(MIN_BOUNDS_SPAN_DEG, 9);
  });

  it('ignores coordinates that are not numbers', () => {
    expect(computeBounds([[Number.NaN, 23.1], [CAPITOLIO[0], Number.POSITIVE_INFINITY]])).toBeNull();
    expect(computeBounds([])).toBeNull();
    const bounds = computeBounds([[Number.NaN, 23.1], CAPITOLIO])!;
    expect((bounds.ne[0] + bounds.sw[0]) / 2).toBeCloseTo(CAPITOLIO[0], 9);
  });
});
