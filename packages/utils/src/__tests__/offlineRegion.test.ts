import { describe, it, expect } from 'vitest';
import {
  OFFLINE_GRID_DEG,
  OFFLINE_MAX_TILES,
  gridCellKey,
  cellBounds,
  estimateTileCount,
  planEviction,
  shouldReresolve,
  type OfflinePackMeta,
} from '../offlineRegion';

// Capitolio, Havana
const HAV = { lat: 23.1357, lng: -82.3666 };

describe('gridCellKey', () => {
  it('is stable for two points in the same cell', () => {
    const a = gridCellKey(HAV.lat, HAV.lng);
    const b = gridCellKey(HAV.lat + 0.01, HAV.lng - 0.01); // <0.12° away, same cell
    expect(a).toBe(b);
  });

  it('differs across a cell boundary', () => {
    const a = gridCellKey(23.10, -82.36);
    const b = gridCellKey(23.10 + OFFLINE_GRID_DEG, -82.36); // next cell north
    expect(a).not.toBe(b);
  });

  it('formats as cell_<latIdx>_<lngIdx>', () => {
    expect(gridCellKey(0.05, 0.05, 0.12)).toBe('cell_0_0');
    expect(gridCellKey(-0.01, -0.01, 0.12)).toBe('cell_-1_-1');
  });
});

describe('cellBounds', () => {
  it('returns a cell of exactly gridDeg on each side, containing the point', () => {
    const b = cellBounds(HAV.lat, HAV.lng);
    expect(b.ne[0] - b.sw[0]).toBeCloseTo(OFFLINE_GRID_DEG, 9);
    expect(b.ne[1] - b.sw[1]).toBeCloseTo(OFFLINE_GRID_DEG, 9);
    expect(HAV.lng).toBeGreaterThanOrEqual(b.sw[0]);
    expect(HAV.lng).toBeLessThanOrEqual(b.ne[0]);
    expect(HAV.lat).toBeGreaterThanOrEqual(b.sw[1]);
    expect(HAV.lat).toBeLessThanOrEqual(b.ne[1]);
  });
});

describe('estimateTileCount', () => {
  it('a 0.12° cell at z10-16 is in the hundreds (fits several per device budget)', () => {
    const tiles = estimateTileCount(cellBounds(HAV.lat, HAV.lng));
    expect(tiles).toBeGreaterThan(300);
    expect(tiles).toBeLessThan(1500);
    // Several cells must fit under the device ceiling.
    expect(Math.floor(OFFLINE_MAX_TILES / tiles)).toBeGreaterThanOrEqual(5);
  });

  it('grows sharply with maxZoom (each level ≈ 4×)', () => {
    const b = cellBounds(HAV.lat, HAV.lng);
    const z15 = estimateTileCount(b, 10, 15);
    const z16 = estimateTileCount(b, 10, 16);
    expect(z16).toBeGreaterThan(z15 * 2);
  });
});

describe('planEviction', () => {
  it('returns nothing when under budget', () => {
    const meta: Record<string, OfflinePackMeta> = {
      a: { tiles: 500, lastUsedAt: 1 },
      b: { tiles: 500, lastUsedAt: 2 },
    };
    expect(planEviction(meta, 5500)).toEqual([]);
  });

  it('evicts least-recently-used first until under budget', () => {
    const meta: Record<string, OfflinePackMeta> = {
      old: { tiles: 2000, lastUsedAt: 1 },
      mid: { tiles: 2000, lastUsedAt: 2 },
      fresh: { tiles: 2000, lastUsedAt: 3 },
    };
    // total 6000 > 5500 → must drop the oldest (2000 → 4000 ≤ 5500)
    expect(planEviction(meta, 5500)).toEqual(['old']);
  });

  it('never evicts a protected key even if it is the oldest', () => {
    const meta: Record<string, OfflinePackMeta> = {
      current: { tiles: 3000, lastUsedAt: 1 }, // oldest but protected
      other: { tiles: 3000, lastUsedAt: 2 },
    };
    expect(planEviction(meta, 5500, ['current'])).toEqual(['other']);
  });
});

describe('shouldReresolve', () => {
  it('is true on first fix (no last point)', () => {
    expect(shouldReresolve(null, HAV)).toBe(true);
  });

  it('is false for a tiny move within the same cell', () => {
    expect(shouldReresolve(HAV, { lat: HAV.lat + 0.0005, lng: HAV.lng + 0.0005 })).toBe(false);
  });

  it('is true when crossing into another cell', () => {
    expect(shouldReresolve(HAV, { lat: HAV.lat + OFFLINE_GRID_DEG, lng: HAV.lng })).toBe(true);
  });
});
