import { describe, it, expect } from 'vitest';
import { resolveFixedPlaces } from '../savedPlaces';

const base = { address: 'Calle 23 e/ L y M, Vedado', latitude: 23.1399, longitude: -82.383 };

describe('resolveFixedPlaces — the Casa / Trabajo slots', () => {
  it('prefers an explicit kind over the label text', () => {
    const home = { ...base, label: 'Mi refugio', kind: 'home' as const };
    const work = { ...base, label: 'La oficina', kind: 'work' as const };
    const r = resolveFixedPlaces([work, home]);
    expect(r.home).toBe(home);
    expect(r.work).toBe(work);
    expect(r.others).toEqual([]);
  });

  it('falls back to the label for legacy rows without a kind', () => {
    const casa = { ...base, label: 'Casa' };
    const trabajo = { ...base, label: 'Trabajo de Ana' };
    const gym = { ...base, label: 'Gimnasio' };
    const r = resolveFixedPlaces([gym, casa, trabajo]);
    expect(r.home).toBe(casa);
    expect(r.work).toBe(trabajo);
    expect(r.others).toEqual([gym]);
  });

  it('leaves both slots empty when nothing matches', () => {
    const r = resolveFixedPlaces([{ ...base, label: 'Gimnasio' }]);
    expect(r.home).toBeUndefined();
    expect(r.work).toBeUndefined();
    expect(r.others).toHaveLength(1);
  });

  it('keeps the first of duplicates and demotes the rest to others', () => {
    const a = { ...base, label: 'Casa', kind: 'home' as const };
    const b = { ...base, label: 'Casa de mamá', kind: 'home' as const };
    const r = resolveFixedPlaces([a, b]);
    expect(r.home).toBe(a);
    expect(r.others).toEqual([b]);
  });

  it('is accent- and case-insensitive on the label fallback', () => {
    const r = resolveFixedPlaces([{ ...base, label: 'CASA' }, { ...base, label: 'trabajo' }]);
    expect(r.home?.label).toBe('CASA');
    expect(r.work?.label).toBe('trabajo');
  });
});
