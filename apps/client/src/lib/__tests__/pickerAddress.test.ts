import { describe, expect, it } from 'vitest';
import { pickerInitialAddress } from '../pickerAddress';

// QA R4-02 (round 4, 2026-11-20): picking the zone "Cayo Hueso" and confirming the pin without
// moving it left "Cayo Hueso, La Habana" as the destination, although the map showed the exact
// address of the pin. Keeping the picked text is right for a street (it is richer than the
// reverse geocode), and wrong for a zone.

describe('pickerInitialAddress', () => {
  it('keeps the picked text for a street the rider confirms', () => {
    expect(pickerInitialAddress({ keepAddress: true }, 'Calle 3ra e/ 4 y 2, Vedado')).toBe('Calle 3ra e/ 4 y 2, Vedado');
  });

  it('drops the zone name, so confirming uses the exact address of the pin', () => {
    expect(pickerInitialAddress({ keepAddress: true, zoneHint: true }, 'Cayo Hueso, La Habana')).toBeNull();
  });

  it('keeps nothing when the entry point did not ask for it', () => {
    expect(pickerInitialAddress({ keepAddress: false }, 'Calle 23 y L')).toBeNull();
  });

  it('returns null without an address', () => {
    expect(pickerInitialAddress({ keepAddress: true }, undefined)).toBeNull();
    expect(pickerInitialAddress({ keepAddress: true }, null)).toBeNull();
  });
});
