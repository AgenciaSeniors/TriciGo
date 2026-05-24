import { describe, it, expect } from 'vitest';
import { lerpCoordinate, type AnimatedCoordinate } from '../animateCoordinate';

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
