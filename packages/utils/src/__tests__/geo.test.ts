import { describe, it, expect } from 'vitest';
import {
  haversineDistance,
  estimateRoadDistance,
  estimateDuration,
  calculateTripDuration,
  adjustETAForVehicle,
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
  it('estimates triciclo duration (~538s for 1300m at 10km/h)', () => {
    const duration = estimateDuration(1300, 'triciclo_basico');
    // 1300m at 10km/h = 1300 / 2.778 m/s = 468s × 1.15 = 538
    expect(duration).toBe(538);
  });

  it('estimates moto duration (~245s for 1300m at 22km/h)', () => {
    const duration = estimateDuration(1300, 'moto_standard');
    // 1300m at 22km/h = 1300 / 6.111 m/s = 212.7s × 1.15 = 245
    expect(duration).toBe(245);
  });

  it('estimates auto duration (~299s for 1300m at 18km/h)', () => {
    const duration = estimateDuration(1300, 'auto_standard');
    // 1300m at 18km/h = 1300 / 5.0 m/s = 260s × 1.15 = 299
    expect(duration).toBe(299);
  });

  it('returns 0 for zero distance', () => {
    expect(estimateDuration(0, 'triciclo_basico')).toBe(0);
  });
});

describe('calculateTripDuration', () => {
  it('returns 0 for zero distance', () => {
    expect(calculateTripDuration(0, 'moto_standard')).toBe(0);
  });

  it('uses urban speed only for short routes (<8km)', () => {
    // 3000m, moto urban = 25 km/h = 6.944 m/s
    // 3000 / 6.944 = 432s × 1.10 = 475.2 → 475
    const duration = calculateTripDuration(3000, 'moto_standard');
    expect(duration).toBe(475);
  });

  it('blends urban + suburban for mid-range routes (8-35km)', () => {
    // 15000m, auto: urban 20 km/h, suburban 35 km/h
    // First 8000m at 5.556 m/s = 1440s
    // Next 7000m at 9.722 m/s = 720s
    // Total = 2160s × 1.10 = 2376
    const duration = calculateTripDuration(15000, 'auto_standard');
    expect(duration).toBe(2376);
  });

  it('uses all three tiers for long intercity routes', () => {
    // 100000m, moto: urban 25, suburban 40, intercity 55
    // First 8000m at 6.944 m/s = 1152s
    // Next 27000m at 11.111 m/s = 2430s
    // Last 65000m at 15.278 m/s = 4254.5s
    // Total = 7836.5s × 1.10 = 8620.2 → 8620
    const duration = calculateTripDuration(100000, 'moto_standard');
    expect(duration).toBe(8620);
  });

  it('falls back to suburban speed for triciclo intercity', () => {
    // 50000m, triciclo: urban 10, suburban 12, intercity null → uses 12
    // First 8000m at 2.778 m/s = 2880s
    // Next 27000m at 3.333 m/s = 8100s
    // Last 15000m at 3.333 m/s = 4500s (fallback to suburban)
    // Total = 15480s × 1.10 = 17028
    const duration = calculateTripDuration(50000, 'triciclo_basico');
    expect(duration).toBe(17028);
  });
});

describe('adjustETAForVehicle', () => {
  it('returns 0 for zero input', () => {
    expect(adjustETAForVehicle(0, 'moto_standard')).toBe(0);
  });

  it('slows down triciclo ETA (25/10 = 2.5x)', () => {
    // raw 300s × (25 / 10) = 750
    expect(adjustETAForVehicle(300, 'triciclo_basico')).toBe(750);
  });

  it('keeps moto ETA unchanged (25/25 = 1.0x)', () => {
    // raw 300s × (25 / 25) = 300
    expect(adjustETAForVehicle(300, 'moto_standard')).toBe(300);
  });

  it('slightly slows auto ETA (25/20 = 1.25x)', () => {
    // raw 300s × (25 / 20) = 375
    expect(adjustETAForVehicle(300, 'auto_standard')).toBe(375);
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
