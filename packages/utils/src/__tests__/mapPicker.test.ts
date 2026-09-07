import { describe, it, expect } from 'vitest';
import { pinConfidence, pickerZoomFor, isNearScreenPoint, coordsEqual } from '../mapPicker';

describe('pinConfidence — what the reverse-geocode layer says about the pin', () => {
  it('is exact when a real street was found under the pin', () => {
    expect(pinConfidence('cross_streets')).toBe('exact');
    expect(pinConfidence('overpass')).toBe('exact');
    expect(pinConfidence('road')).toBe('exact');
  });

  it('is near when only the nearest street within 200 m was found', () => {
    expect(pinConfidence('nearest_street')).toBe('near');
  });

  it('is none when the geocoder fell back to a locality or a POI alone', () => {
    expect(pinConfidence('locality')).toBe('none');
    expect(pinConfidence('poi_only')).toBe('none');
    expect(pinConfidence(null)).toBe('none');
  });
});

describe('pickerZoomFor', () => {
  it('opens close when adjusting an existing point, wider from scratch', () => {
    expect(pickerZoomFor(true)).toBe(17);
    expect(pickerZoomFor(false)).toBe(15);
  });
});

describe('isNearScreenPoint — ignore long-presses that land on a marker', () => {
  it('is true inside the radius', () => {
    expect(isNearScreenPoint({ x: 100, y: 100 }, [{ x: 120, y: 110 }])).toBe(true);
  });

  it('is false outside the radius', () => {
    expect(isNearScreenPoint({ x: 100, y: 100 }, [{ x: 200, y: 200 }])).toBe(false);
  });

  it('skips markers that could not be projected and an empty list', () => {
    expect(isNearScreenPoint({ x: 100, y: 100 }, [null, undefined])).toBe(false);
    expect(isNearScreenPoint({ x: 100, y: 100 }, [])).toBe(false);
  });

  it('honours a custom radius', () => {
    expect(isNearScreenPoint({ x: 0, y: 0 }, [{ x: 30, y: 0 }], 20)).toBe(false);
    expect(isNearScreenPoint({ x: 0, y: 0 }, [{ x: 30, y: 0 }], 40)).toBe(true);
  });
});

describe('coordsEqual — drag-origin reconciliation', () => {
  it('treats the same point as equal within epsilon', () => {
    expect(coordsEqual({ latitude: 23.1357, longitude: -82.3666 }, { latitude: 23.1357, longitude: -82.3666 })).toBe(true);
    expect(coordsEqual({ latitude: 23.1357, longitude: -82.3666 }, { latitude: 23.13570000001, longitude: -82.3666 })).toBe(true);
  });

  it('is false when the points differ beyond epsilon', () => {
    expect(coordsEqual({ latitude: 23.1357, longitude: -82.3666 }, { latitude: 23.13571, longitude: -82.3666 })).toBe(false);
  });

  it('handles nulls: both null is equal, one null is not', () => {
    expect(coordsEqual(null, null)).toBe(true);
    expect(coordsEqual(null, { latitude: 1, longitude: 1 })).toBe(false);
    expect(coordsEqual({ latitude: 1, longitude: 1 }, null)).toBe(false);
  });
});
