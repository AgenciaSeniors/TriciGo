import { describe, it, expect } from 'vitest';
import { normalizeCubanCityLabel } from '../cuba-geo';

describe('normalizeCubanCityLabel', () => {
  it('strips "Provincia de " prefix', () => {
    expect(normalizeCubanCityLabel('Provincia de La Habana')).toBe('La Habana');
    expect(normalizeCubanCityLabel('Provincia de Sancti Spíritus')).toBe('Sancti Spíritus');
    expect(normalizeCubanCityLabel('Provincia de Pinar del Río')).toBe('Pinar del Río');
  });

  it('strips "Municipio de " prefix', () => {
    expect(normalizeCubanCityLabel('Municipio de Plaza de la Revolución')).toBe('Plaza de la Revolución');
    expect(normalizeCubanCityLabel('Municipio Habana del Este')).toBe('Habana del Este');
  });

  it('strips "Ciudad de " prefix', () => {
    expect(normalizeCubanCityLabel('Ciudad de La Habana')).toBe('La Habana');
  });

  it('is case insensitive on the prefix', () => {
    expect(normalizeCubanCityLabel('provincia de Holguín')).toBe('Holguín');
    expect(normalizeCubanCityLabel('PROVINCIA DE Granma')).toBe('Granma');
    expect(normalizeCubanCityLabel('MUNICIPIO de Trinidad')).toBe('Trinidad');
  });

  it('passes clean names through unchanged', () => {
    expect(normalizeCubanCityLabel('La Habana')).toBe('La Habana');
    expect(normalizeCubanCityLabel('Trinidad')).toBe('Trinidad');
    expect(normalizeCubanCityLabel('Vedado')).toBe('Vedado');
    expect(normalizeCubanCityLabel('Centro Habana')).toBe('Centro Habana');
  });

  it('does NOT strip "de" when there is no admin prefix in front of it', () => {
    // "Sierra Maestra" / "Cayo de la Rosa" must not lose any words —
    // the regex anchors at start AND requires the admin keyword first.
    expect(normalizeCubanCityLabel('Sierra Maestra')).toBe('Sierra Maestra');
    expect(normalizeCubanCityLabel('Cayo de la Rosa')).toBe('Cayo de la Rosa');
    expect(normalizeCubanCityLabel('Playa Girón')).toBe('Playa Girón');
  });

  it('handles null and empty inputs gracefully', () => {
    expect(normalizeCubanCityLabel(null)).toBeNull();
    expect(normalizeCubanCityLabel(undefined)).toBeNull();
    expect(normalizeCubanCityLabel('')).toBeNull();
  });

  it('falls back to the original when the strip leaves a 0-1 char remnant', () => {
    // Pathological input — basically just the prefix. Better to show
    // "Provincia de" verbatim than render an empty chip.
    expect(normalizeCubanCityLabel('Provincia de A')).toBe('Provincia de A');
    expect(normalizeCubanCityLabel('Municipio')).toBe('Municipio');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeCubanCityLabel('  Provincia de La Habana  ')).toBe('La Habana');
    expect(normalizeCubanCityLabel('  La Habana  ')).toBe('La Habana');
  });

  it('is idempotent (running twice gives the same result)', () => {
    const inputs = [
      'Provincia de La Habana',
      'La Habana',
      'Centro Habana',
      'Provincia de Sancti Spíritus',
    ];
    for (const input of inputs) {
      const once = normalizeCubanCityLabel(input);
      const twice = normalizeCubanCityLabel(once);
      expect(twice).toBe(once);
    }
  });
});
