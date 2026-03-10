import { describe, it, expect } from 'vitest';
import {
  haversineDistance,
  estimateRoadDistance,
  estimateDuration,
  HAVANA_PRESETS,
  HAVANA_CENTER,
} from '../geo';

describe('haversineDistance', () => {
  it('calculates distance between Capitolio and Hotel Nacional (~3.8km)', () => {
    const capitolio = HAVANA_PRESETS.find((p) => p.label === 'Capitolio')!;
    const hotelNacional = HAVANA_PRESETS.find((p) => p.label === 'Hotel Nacional')!;
    const distance = haversineDistance(
      { latitude: capitolio.latitude, longitude: capitolio.longitude },
      { latitude: hotelNacional.latitude, longitude: hotelNacional.longitude },
    );
    // ~3.8 km straight-line distance
    expect(distance).toBeGreaterThan(3000);
    expect(distance).toBeLessThan(5000);
  });

  it('returns 0 for identical points', () => {
    const distance = haversineDistance(HAVANA_CENTER, HAVANA_CENTER);
    expect(distance).toBe(0);
  });

  it('calculates short distance between Parque Central and Capitolio (~200m)', () => {
    const parque = HAVANA_PRESETS.find((p) => p.label === 'Parque Central')!;
    const capitolio = HAVANA_PRESETS.find((p) => p.label === 'Capitolio')!;
    const distance = haversineDistance(
      { latitude: parque.latitude, longitude: parque.longitude },
      { latitude: capitolio.latitude, longitude: capitolio.longitude },
    );
    expect(distance).toBeGreaterThan(50);
    expect(distance).toBeLessThan(500);
  });
});

describe('estimateRoadDistance', () => {
  it('applies 1.3x urban factor', () => {
    expect(estimateRoadDistance(1000)).toBe(1300);
  });

  it('handles zero', () => {
    expect(estimateRoadDistance(0)).toBe(0);
  });

  it('handles large distances', () => {
    expect(estimateRoadDistance(10000)).toBe(13000);
  });
});

describe('estimateDuration', () => {
  it('estimates triciclo duration (~312s for 1300m at 15km/h)', () => {
    const duration = estimateDuration(1300, 'triciclo_basico');
    // 1300m at 15km/h = 1.3/15 hours = 312s
    expect(duration).toBe(312);
  });

  it('estimates moto duration (~156s for 1300m at 30km/h)', () => {
    const duration = estimateDuration(1300, 'moto_standard');
    // 1300m at 30km/h = 1.3/30 hours = 156s
    expect(duration).toBe(156);
  });

  it('estimates auto duration (~187s for 1300m at 25km/h)', () => {
    const duration = estimateDuration(1300, 'auto_standard');
    // 1300m at 25km/h = 1.3/25 hours = 187.2s ≈ 187
    expect(duration).toBe(187);
  });

  it('returns 0 for zero distance', () => {
    expect(estimateDuration(0, 'triciclo_basico')).toBe(0);
  });
});

describe('HAVANA_PRESETS', () => {
  it('contains 8 presets', () => {
    expect(HAVANA_PRESETS).toHaveLength(8);
  });

  it('all presets are within Havana bounding box', () => {
    // Havana bounding box: lat 23.0–23.2, lng -82.5–-82.3
    for (const preset of HAVANA_PRESETS) {
      expect(preset.latitude).toBeGreaterThan(23.0);
      expect(preset.latitude).toBeLessThan(23.2);
      expect(preset.longitude).toBeGreaterThan(-82.5);
      expect(preset.longitude).toBeLessThan(-82.3);
    }
  });

  it('all presets have label and address', () => {
    for (const preset of HAVANA_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.address.length).toBeGreaterThan(0);
    }
  });

  it('all presets have unique labels', () => {
    const labels = HAVANA_PRESETS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('HAVANA_CENTER', () => {
  it('is within Havana', () => {
    expect(HAVANA_CENTER.latitude).toBeGreaterThan(23.0);
    expect(HAVANA_CENTER.latitude).toBeLessThan(23.2);
    expect(HAVANA_CENTER.longitude).toBeGreaterThan(-82.5);
    expect(HAVANA_CENTER.longitude).toBeLessThan(-82.3);
  });
});
