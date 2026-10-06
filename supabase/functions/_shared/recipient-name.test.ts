import { describe, expect, it } from 'vitest';
import { maskRecipientName } from './recipient-name';

describe('maskRecipientName', () => {
  it('keeps the first name and the initial of the next word', () => {
    expect(maskRecipientName('Eduardo Daniel Pérez Ruiz')).toBe('Eduardo D.');
    expect(maskRecipientName('María Pérez')).toBe('María P.');
  });

  it('keeps a single name as is', () => {
    expect(maskRecipientName('Yunior')).toBe('Yunior');
  });

  it('handles extra whitespace and accented initials', () => {
    expect(maskRecipientName('  Ana   Álvarez  ')).toBe('Ana Á.');
  });

  it('caps a very long first word', () => {
    expect(maskRecipientName('A'.repeat(60) + ' B')).toBe('A'.repeat(30) + ' B.');
  });

  it('returns an empty string for missing names', () => {
    expect(maskRecipientName(null)).toBe('');
    expect(maskRecipientName(undefined)).toBe('');
    expect(maskRecipientName('   ')).toBe('');
  });
});
