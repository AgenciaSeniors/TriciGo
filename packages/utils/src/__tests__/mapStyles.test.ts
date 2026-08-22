import { describe, it, expect } from 'vitest';
import { MAP_STYLE_LIGHT, MAP_STYLE_DARK, MARKER, MAP_COLORS } from '../mapStyles';

describe('map styles', () => {
  it('exposes a light and a dark base style', () => {
    expect(MAP_STYLE_LIGHT).toBe('mapbox://styles/mapbox/light-v11');
    expect(MAP_STYLE_DARK).toBe('mapbox://styles/mapbox/dark-v11');
  });
});

// These values are shared across driver, client and web. The client's dark
// map work only ADDS tokens; changing an existing one silently restyles the
// other two apps, which is what these assertions are here to catch.
describe('shared marker tokens', () => {
  it('keeps the red disc dropoff the driver and web maps render', () => {
    expect(MAP_COLORS.dropoff).toBe('#EF4444');
    expect(MARKER.dropoff).toEqual({
      size: 48,
      innerDot: 17,
      tailH: 18,
      shadow: '0 3px 12px rgba(239,68,68,0.35)',
    });
  });

  it('keeps the brand-tinted pin the client map renders separate from it', () => {
    expect(MARKER.dropoffPin.size).toBe(44);
    expect(MARKER.dropoffPin.size).not.toBe(MARKER.dropoff.size);
  });

  it('keeps pickup and driver dimensions', () => {
    expect(MARKER.pickup.size).toBe(39);
    expect(MARKER.driver).toMatchObject({ size: 45, ringSize: 60 });
    expect(MAP_COLORS.pickup).toBe('#22c55e');
  });
});
