import { describe, expect, it } from 'vitest';
import { searchResultA11yLabel } from '../addressSearch';

// R3-09 (QA round 3): the corner "Calle 23 y Calle 12, Plaza de la Revolución"
// was read twice by the screen reader, because its name and address are the
// same text and the label joined them anyway.

describe('searchResultA11yLabel', () => {
  it('reads the name once when the address is the same text', () => {
    const a = 'Calle 23 y Calle 12, Plaza de la Revolución';
    expect(searchResultA11yLabel(a, a)).toBe(a);
  });

  it('ignores case and surrounding spaces when comparing', () => {
    expect(searchResultA11yLabel('Coppelia ', 'coppelia')).toBe('Coppelia');
  });

  it('reads the name and then the address when they differ', () => {
    expect(searchResultA11yLabel('Coppelia', 'Calle 23 y L, Vedado')).toBe('Coppelia, Calle 23 y L, Vedado');
  });

  it('falls back to whichever one exists', () => {
    expect(searchResultA11yLabel(undefined, 'Calle 12 e/ Zapata')).toBe('Calle 12 e/ Zapata');
    expect(searchResultA11yLabel('Coppelia', '')).toBe('Coppelia');
    expect(searchResultA11yLabel(null, null)).toBe('');
  });
});
