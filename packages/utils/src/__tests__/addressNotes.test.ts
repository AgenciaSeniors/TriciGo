import { describe, it, expect } from 'vitest';
import { trimNotes, ADDRESS_NOTES_MAX } from '../addressNotes';

describe('trimNotes — rider notes for the driver', () => {
  it('returns null for nothing worth sending', () => {
    expect(trimNotes(undefined)).toBeNull();
    expect(trimNotes(null)).toBeNull();
    expect(trimNotes('')).toBeNull();
    expect(trimNotes('   \n  ')).toBeNull();
  });

  it('trims the edges and collapses runs of spaces, keeping line breaks', () => {
    expect(trimNotes('  #302   apto 4 \n edificio   azul  ')).toBe('#302 apto 4\nedificio azul');
  });

  it('caps at the column limit so the insert never fails the CHECK', () => {
    const long = 'a'.repeat(ADDRESS_NOTES_MAX + 50);
    expect(trimNotes(long)).toHaveLength(ADDRESS_NOTES_MAX);
    expect(ADDRESS_NOTES_MAX).toBe(200);
  });
});
