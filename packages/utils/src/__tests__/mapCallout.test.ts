import { describe, it, expect } from 'vitest';
import {
  estimateVehicleEtaMinutes,
  formatVehicleEtaMinutes,
  formatVehicleDistance,
} from '../mapCallout';

describe('estimateVehicleEtaMinutes', () => {
  it('turns straight-line metres into a city-traffic minute estimate', () => {
    // 1 km straight line → 1.3 km of road → ~4 min at 20 km/h
    expect(estimateVehicleEtaMinutes(1000)).toBe(4);
    expect(estimateVehicleEtaMinutes(2000)).toBe(8);
  });

  it('never returns zero — a vehicle on your corner still has to reach you', () => {
    expect(estimateVehicleEtaMinutes(10)).toBe(1);
    expect(estimateVehicleEtaMinutes(0)).toBe(1);
  });

  it('returns null for a distance it cannot trust', () => {
    expect(estimateVehicleEtaMinutes(null)).toBe(null);
    expect(estimateVehicleEtaMinutes(undefined)).toBe(null);
    expect(estimateVehicleEtaMinutes(NaN)).toBe(null);
    expect(estimateVehicleEtaMinutes(-5)).toBe(null);
  });
});

describe('formatVehicleEtaMinutes', () => {
  it('labels whole minutes', () => {
    expect(formatVehicleEtaMinutes(3)).toBe('3 min');
    expect(formatVehicleEtaMinutes(1)).toBe('1 min');
  });

  it('caps absurd values instead of rendering a wall of digits', () => {
    expect(formatVehicleEtaMinutes(180)).toBe('60+ min');
  });

  it('returns null rather than inventing a number', () => {
    expect(formatVehicleEtaMinutes(null)).toBe(null);
    expect(formatVehicleEtaMinutes(undefined)).toBe(null);
    expect(formatVehicleEtaMinutes(NaN)).toBe(null);
    expect(formatVehicleEtaMinutes(0)).toBe(null);
  });
});

describe('formatVehicleDistance', () => {
  it('uses metres below a kilometre, rounded to something readable', () => {
    expect(formatVehicleDistance(120)).toBe('120 m');
    expect(formatVehicleDistance(127)).toBe('130 m');
  });

  it('switches to kilometres with one decimal past 1000 m', () => {
    expect(formatVehicleDistance(1000)).toBe('1.0 km');
    expect(formatVehicleDistance(2450)).toBe('2.5 km');
  });

  it('returns null rather than inventing a distance', () => {
    expect(formatVehicleDistance(null)).toBe(null);
    expect(formatVehicleDistance(undefined)).toBe(null);
    expect(formatVehicleDistance(NaN)).toBe(null);
    expect(formatVehicleDistance(-5)).toBe(null);
  });
});
