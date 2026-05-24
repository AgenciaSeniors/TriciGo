import { describe, it, expect } from 'vitest';
import { vehicleMarkerRotationOffset, VEHICLE_MARKER_ROTATION_OFFSET_DEG } from '../markers';

describe('VEHICLE_MARKER_ROTATION_OFFSET_DEG', () => {
  it('is empty by default — all stock fleet PNGs follow the "point UP" convention', () => {
    // BUG-295 resolved: triciclo.png was re-exported pointing north, so
    // the prior `triciclo: 180` entry is gone. The dictionary should
    // stay empty unless a future non-standard asset enters the fleet.
    expect(Object.keys(VEHICLE_MARKER_ROTATION_OFFSET_DEG)).toEqual([]);
  });
});

describe('vehicleMarkerRotationOffset', () => {
  it('returns 0 for triciclo (post BUG-295 asset fix)', () => {
    // Previously returned 180° to compensate for an east-pointing PNG.
    // The asset was rotated 90° CCW (now points north) and the offset
    // removed. If you ever see this assertion fail with 180, the asset
    // was reverted — re-rotate it before changing this test.
    expect(vehicleMarkerRotationOffset('triciclo')).toBe(0);
  });

  it('returns 0 for all standard vehicles', () => {
    expect(vehicleMarkerRotationOffset('moto')).toBe(0);
    expect(vehicleMarkerRotationOffset('auto')).toBe(0);
    expect(vehicleMarkerRotationOffset('auto_clasico')).toBe(0);
    expect(vehicleMarkerRotationOffset('confort')).toBe(0);
  });

  it('returns 0 for unknown / nullish vehicle types', () => {
    expect(vehicleMarkerRotationOffset('unknown_vehicle')).toBe(0);
    expect(vehicleMarkerRotationOffset(null)).toBe(0);
    expect(vehicleMarkerRotationOffset(undefined)).toBe(0);
    expect(vehicleMarkerRotationOffset('')).toBe(0);
  });

  it('would return a custom offset if one were registered (extension point)', () => {
    // Sanity check the lookup table still works for future non-standard
    // assets. NOT registered in the live dictionary, but we test the
    // lookup mechanism by temporarily injecting one.
    const original = (VEHICLE_MARKER_ROTATION_OFFSET_DEG as Record<string, number>)['weird_asset'];
    try {
      (VEHICLE_MARKER_ROTATION_OFFSET_DEG as Record<string, number>)['weird_asset'] = 45;
      expect(vehicleMarkerRotationOffset('weird_asset')).toBe(45);
    } finally {
      // Restore — don't leak test state into other tests.
      if (original === undefined) {
        delete (VEHICLE_MARKER_ROTATION_OFFSET_DEG as Record<string, number>)['weird_asset'];
      } else {
        (VEHICLE_MARKER_ROTATION_OFFSET_DEG as Record<string, number>)['weird_asset'] = original;
      }
    }
  });
});
