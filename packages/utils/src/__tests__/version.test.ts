import { describe, it, expect } from 'vitest';
import { isVersionOutdated } from '../version';

describe('isVersionOutdated', () => {
  it('returns true when current is strictly lower than latest', () => {
    expect(isVersionOutdated('1.1.0', '1.2.0')).toBe(true);
    expect(isVersionOutdated('1.1.0', '2.0.0')).toBe(true);
    expect(isVersionOutdated('1.1.0', '1.1.1')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isVersionOutdated('1.1.0', '1.1.0')).toBe(false);
  });

  it('returns false when current is newer than latest', () => {
    expect(isVersionOutdated('1.2.0', '1.1.0')).toBe(false);
    expect(isVersionOutdated('2.0.0', '1.9.9')).toBe(false);
  });

  it('compares segments numerically, not lexicographically', () => {
    expect(isVersionOutdated('1.10.0', '1.9.0')).toBe(false);
    expect(isVersionOutdated('1.9.0', '1.10.0')).toBe(true);
  });

  it('treats missing segments as zero', () => {
    expect(isVersionOutdated('1.1', '1.1.1')).toBe(true);
    expect(isVersionOutdated('1.1', '1.1.0')).toBe(false);
    expect(isVersionOutdated('1.1.0', '1.2')).toBe(true);
  });

  it('tolerates a leading "v" and surrounding whitespace', () => {
    expect(isVersionOutdated('v1.1.0', '1.2.0')).toBe(true);
    expect(isVersionOutdated(' 1.1.0 ', ' 1.2.0 ')).toBe(true);
  });

  it('fails safe (false) on malformed or empty input so users are never nagged by a bad config value', () => {
    expect(isVersionOutdated('', '1.2.0')).toBe(false);
    expect(isVersionOutdated('1.1.0', '')).toBe(false);
    expect(isVersionOutdated('abc', '1.2.0')).toBe(false);
    expect(isVersionOutdated('1.1.0', 'abc')).toBe(false);
  });

  it('ignores non-numeric suffixes inside later segments', () => {
    // parseInt('0-beta') === 0 → "1.1.0-beta" behaves like "1.1.0"
    expect(isVersionOutdated('1.1.0-beta', '1.1.1')).toBe(true);
    expect(isVersionOutdated('1.1.0-beta', '1.1.0')).toBe(false);
  });
});
