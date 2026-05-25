import { describe, it, expect } from 'vitest';
import {
  lerpCoordinate,
  lerpHeading,
  HEADING_SNAP_THRESHOLD_DEG,
  type AnimatedCoordinate,
} from '../animateCoordinate';

// Habana reference coords used across tests
const VEDADO: AnimatedCoordinate = { latitude: 23.1429, longitude: -82.3949 };
const CENTRO_HABANA: AnimatedCoordinate = { latitude: 23.1361, longitude: -82.3680 };

describe('lerpCoordinate', () => {
  it('returns `from` when t = 0', () => {
    const result = lerpCoordinate(VEDADO, CENTRO_HABANA, 0);
    expect(result.latitude).toBeCloseTo(VEDADO.latitude, 10);
    expect(result.longitude).toBeCloseTo(VEDADO.longitude, 10);
  });

  it('returns `to` when t = 1', () => {
    const result = lerpCoordinate(VEDADO, CENTRO_HABANA, 1);
    expect(result.latitude).toBeCloseTo(CENTRO_HABANA.latitude, 10);
    expect(result.longitude).toBeCloseTo(CENTRO_HABANA.longitude, 10);
  });

  it('returns the midpoint when t = 0.5', () => {
    const result = lerpCoordinate(VEDADO, CENTRO_HABANA, 0.5);
    const expectedLat = (VEDADO.latitude + CENTRO_HABANA.latitude) / 2;
    const expectedLng = (VEDADO.longitude + CENTRO_HABANA.longitude) / 2;
    expect(result.latitude).toBeCloseTo(expectedLat, 10);
    expect(result.longitude).toBeCloseTo(expectedLng, 10);
  });

  it('clamps t < 0 to 0 (returns `from`)', () => {
    const result = lerpCoordinate(VEDADO, CENTRO_HABANA, -0.5);
    expect(result.latitude).toBeCloseTo(VEDADO.latitude, 10);
    expect(result.longitude).toBeCloseTo(VEDADO.longitude, 10);
  });

  it('clamps t > 1 to 1 (returns `to`) — protects against late rAF frames overshooting', () => {
    const result = lerpCoordinate(VEDADO, CENTRO_HABANA, 1.5);
    expect(result.latitude).toBeCloseTo(CENTRO_HABANA.latitude, 10);
    expect(result.longitude).toBeCloseTo(CENTRO_HABANA.longitude, 10);
  });

  it('interpolates linearly across a quarter step', () => {
    // From (0,0) to (4,8) at t=0.25 → (1,2)
    const result = lerpCoordinate(
      { latitude: 0, longitude: 0 },
      { latitude: 4, longitude: 8 },
      0.25,
    );
    expect(result.latitude).toBeCloseTo(1, 10);
    expect(result.longitude).toBeCloseTo(2, 10);
  });

  it('handles identical from/to (degenerate animation)', () => {
    const result = lerpCoordinate(VEDADO, VEDADO, 0.5);
    expect(result.latitude).toBeCloseTo(VEDADO.latitude, 10);
    expect(result.longitude).toBeCloseTo(VEDADO.longitude, 10);
  });

  it('handles negative coords correctly (W/S hemispheres)', () => {
    // From Habana (N/W) to Buenos Aires (S/W) — both longitudes negative
    const result = lerpCoordinate(
      { latitude: 23.13, longitude: -82.36 },
      { latitude: -34.6, longitude: -58.4 },
      0.5,
    );
    // Midpoint should be at ((23.13 + -34.6)/2, (-82.36 + -58.4)/2)
    expect(result.latitude).toBeCloseTo(-5.735, 5);
    expect(result.longitude).toBeCloseTo(-70.38, 5);
  });
});

// ─────────────────────────────────────────────────────────────────
// PR B — lerpHeading (compass angle interpolation, shortest path)
// ─────────────────────────────────────────────────────────────────
describe('lerpHeading', () => {
  it('returns `from` when t = 0', () => {
    expect(lerpHeading(45, 270, 0)).toBeCloseTo(45, 6);
  });

  it('returns `to` when t = 1', () => {
    expect(lerpHeading(45, 270, 1)).toBeCloseTo(270, 6);
  });

  it('interpolates linearly when no wrap-around (0→90)', () => {
    expect(lerpHeading(0, 90, 0.5)).toBeCloseTo(45, 6);
    expect(lerpHeading(0, 90, 0.25)).toBeCloseTo(22.5, 6);
    expect(lerpHeading(0, 90, 0.75)).toBeCloseTo(67.5, 6);
  });

  it('takes the shortest path across 0/360 wrap (350 → 10)', () => {
    // Shortest path is +20° (350 → 360/0 → 10), NOT -340° backwards.
    // At t=0.5 the result should be 0 (or 360 equivalently).
    const mid = lerpHeading(350, 10, 0.5);
    expect(mid).toBeCloseTo(0, 6);
    // At t=0.25 — quarter way along the short arc (350 → 355).
    expect(lerpHeading(350, 10, 0.25)).toBeCloseTo(355, 6);
  });

  it('takes the shortest path across 0/360 wrap (10 → 350)', () => {
    // Opposite direction: shortest path is -20° (10 → 0/360 → 350).
    expect(lerpHeading(10, 350, 0.5)).toBeCloseTo(0, 6);
    expect(lerpHeading(10, 350, 0.25)).toBeCloseTo(5, 6);
  });

  it('clamps t outside [0, 1]', () => {
    expect(lerpHeading(0, 90, -0.5)).toBeCloseTo(0, 6);
    expect(lerpHeading(0, 90, 1.5)).toBeCloseTo(90, 6);
  });

  it('handles exact 180° apart deterministically (clockwise)', () => {
    // Both paths are equal length — we pick clockwise (positive delta).
    expect(lerpHeading(0, 180, 0.5)).toBeCloseTo(90, 6);
    expect(lerpHeading(90, 270, 0.5)).toBeCloseTo(180, 6);
  });

  it('returns values always in [0, 360)', () => {
    // Wrap path that crosses 360 should normalize to [0, 360).
    expect(lerpHeading(350, 10, 1)).toBeCloseTo(10, 6);
    expect(lerpHeading(350, 10, 0.9)).toBeGreaterThanOrEqual(0);
    expect(lerpHeading(350, 10, 0.9)).toBeLessThan(360);
  });

  it('exposes a snap threshold of 60° (matches hook)', () => {
    expect(HEADING_SNAP_THRESHOLD_DEG).toBe(60);
  });
});
