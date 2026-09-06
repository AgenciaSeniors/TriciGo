import { describe, it, expect } from 'vitest';
import { poiVisualGroup, POI_VISUAL_GROUPS } from '../poiCategories';

// Mirror of TRICIGO_CATEGORIES (@tricigo/api) — utils must not import api.
// scripts/check-poi-taxonomy.mjs (CI) keeps every surface in sync with
// poi_taxonomy() in migration 00579.
const TAXONOMY = [
  'hospital', 'pharmacy', 'school', 'gov', 'hotel', 'restaurant', 'paladar',
  'cafe', 'bar', 'supermarket', 'shop', 'bank', 'atm', 'gas_station',
  'museum', 'park', 'beach', 'embassy', 'religion', 'transport', 'other',
  'landmark', 'venue', 'stadium',
] as const;

describe('poiVisualGroup', () => {
  it('maps every taxonomy value to a real group (never other by accident)', () => {
    for (const c of TAXONOMY) {
      if (c === 'other') continue;
      expect(poiVisualGroup(c).key, c).not.toBe('other');
    }
  });

  it('new values land in culture', () => {
    expect(poiVisualGroup('landmark').key).toBe('culture');
    expect(poiVisualGroup('venue').key).toBe('culture');
    expect(poiVisualGroup('stadium').key).toBe('culture');
  });

  it('subcategory fallback covers stadium / memorial / viewpoint', () => {
    expect(poiVisualGroup(null, 'leisure', 'stadium').key).toBe('culture');
    expect(poiVisualGroup(null, 'historic', 'memorial').key).toBe('culture');
    expect(poiVisualGroup(undefined, undefined, 'viewpoint').key).toBe('culture');
  });

  it('groups are unique by key', () => {
    expect(new Set(POI_VISUAL_GROUPS.map((g) => g.key)).size).toBe(POI_VISUAL_GROUPS.length);
  });
});
