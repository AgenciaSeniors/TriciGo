import { describe, it, expect } from 'vitest';
import { formatVehicleEta, formatVehicleDistance } from '../mapCallout';

describe('formatVehicleEta', () => {
  it('rounds up to whole minutes so nobody is promised less than the wait', () => {
    expect(formatVehicleEta(61)).toBe('2 min');
    expect(formatVehicleEta(120)).toBe('2 min');
  });

  it('never says "0 min" — under a minute is still a minute away', () => {
    expect(formatVehicleEta(5)).toBe('1 min');
    expect(formatVehicleEta(0)).toBe(null);
  });

  it('returns null when there is no estimate rather than inventing one', () => {
    expect(formatVehicleEta(null)).toBe(null);
    expect(formatVehicleEta(undefined)).toBe(null);
    expect(formatVehicleEta(NaN)).toBe(null);
  });

  it('caps absurd values instead of rendering a wall of digits', () => {
    expect(formatVehicleEta(60 * 60 * 3)).toBe('60+ min');
  });

  it('rejects negatives from clock skew', () => {
    expect(formatVehicleEta(-30)).toBe(null);
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
