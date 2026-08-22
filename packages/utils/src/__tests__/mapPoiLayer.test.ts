import { describe, it, expect } from 'vitest';
import {
  POI_LAYER_ID,
  POI_SOURCE_ID,
  POI_SOURCE_LAYER,
  POI_MAKI_HIDDEN,
  POI_FALLBACK_ICON,
  poiFilter,
  poiIconImage,
  poiNameFromFeature,
} from '../mapPoiLayer';

describe('poi layer constants', () => {
  it('binds to the style source the tiles already carry', () => {
    expect(POI_SOURCE_ID).toBe('composite');
    expect(POI_SOURCE_LAYER).toBe('poi_label');
  });

  it('uses an id of our own so taps can be filtered to it', () => {
    expect(POI_LAYER_ID).toBe('tricigo-places');
  });
});

// This layer shipped twice without drawing anything: once because the icon
// names were wrong, once because a whitelist of useful-sounding categories
// excluded almost every real place. Both are external vocabularies, so
// assert the SHAPE of the contract rather than restating the constants.
describe('poiFilter', () => {
  it('hides a blocklist instead of allowing a whitelist', () => {
    // A whitelist here dropped 10 of 13 real places in a measured
    // neighbourhood — the commonest maki in the data is plain `marker`,
    // which no hand-written list of useful categories would contain.
    expect(poiFilter[0]).toBe('all');
    const [op, prop, , onMatch, onDefault] = poiFilter[1] as unknown[];
    expect(op).toBe('match');
    expect(prop).toEqual(['get', 'maki']);
    expect(onMatch).toBe(false);
    expect(onDefault).toBe(true);
  });

  it('lets zoom control density via filterrank, the way the stock style does', () => {
    const rank = poiFilter[2] as unknown[];
    expect(rank[0]).toBe('<=');
    expect(rank[1]).toEqual(['get', 'filterrank']);
    expect((rank[2] as unknown[])[0]).toBe('step');
  });

  it('keeps ordinary destinations visible', () => {
    for (const kept of ['marker', 'restaurant', 'hospital', 'shop', 'attraction']) {
      expect(POI_MAKI_HIDDEN).not.toContain(kept);
    }
  });

  it('uses only bare maki names — v11 sprites have no size suffix', () => {
    for (const name of POI_MAKI_HIDDEN) {
      expect(name).not.toMatch(/-\d+$/);
    }
    expect(POI_FALLBACK_ICON).not.toMatch(/-\d+$/);
  });
});

describe('poiIconImage', () => {
  it('falls back to a plain marker when the maki has no sprite', () => {
    expect(poiIconImage[0]).toBe('coalesce');
    expect(poiIconImage[1]).toEqual(['image', ['get', 'maki']]);
    expect(poiIconImage[2]).toEqual(['image', POI_FALLBACK_ICON]);
  });
});

describe('poiNameFromFeature', () => {
  it('reads the localized name when the tile has one', () => {
    expect(poiNameFromFeature({ properties: { name_es: 'Farmacia', name: 'Pharmacy' } })).toBe('Farmacia');
  });

  it('falls back to the neutral name', () => {
    expect(poiNameFromFeature({ properties: { name: 'Pharmacy' } })).toBe('Pharmacy');
  });

  it('returns null rather than an empty label', () => {
    expect(poiNameFromFeature({ properties: {} })).toBe(null);
    expect(poiNameFromFeature({ properties: { name: '   ' } })).toBe(null);
    expect(poiNameFromFeature(undefined)).toBe(null);
    expect(poiNameFromFeature({})).toBe(null);
  });
});
