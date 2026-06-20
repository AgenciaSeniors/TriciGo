import { describe, it, expect } from 'vitest';
import { formatRating } from '../rating';

describe('formatRating', () => {
  it('formats a finite rating to one decimal', () => {
    expect(formatRating(4.5)).toBe('4.5');
    expect(formatRating(5)).toBe('5.0');
    expect(formatRating(3.27)).toBe('3.3');
  });

  it('treats 0 as a valid rating, not as missing', () => {
    expect(formatRating(0)).toBe('0.0');
  });

  it('returns the default fallback "—" for null/undefined/NaN', () => {
    expect(formatRating(null)).toBe('—');
    expect(formatRating(undefined)).toBe('—');
    expect(formatRating(NaN)).toBe('—');
  });

  it('returns the default fallback for non-finite numbers', () => {
    expect(formatRating(Infinity)).toBe('—');
    expect(formatRating(-Infinity)).toBe('—');
  });

  it('honors a custom fallback (e.g. the localized "Nuevo" label)', () => {
    expect(formatRating(null, 'Nuevo')).toBe('Nuevo');
    expect(formatRating(undefined, 'Nuevo')).toBe('Nuevo');
    // a real rating still wins over the fallback
    expect(formatRating(4.9, 'Nuevo')).toBe('4.9');
  });
});
