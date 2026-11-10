import { describe, expect, it } from 'vitest';
import { assistOwnership, sortWaitingForViewer } from '../supportOwnership';

describe('assistOwnership', () => {
  it('tells mine, other and none apart', () => {
    expect(assistOwnership('u1', 'u1')).toBe('mine');
    expect(assistOwnership('u1', 'u2')).toBe('other');
    expect(assistOwnership(null, 'u2')).toBe('none');
    expect(assistOwnership(undefined, 'u2')).toBe('none');
    expect(assistOwnership('u1', null)).toBe('other');
    expect(assistOwnership('u1', undefined)).toBe('other');
  });
});

describe('sortWaitingForViewer', () => {
  const ride = (id: string, owner_id: string | null) => ({ id, owner_id, help_requested_at: null });

  it("puts the viewer's rides first and keeps the original order otherwise", () => {
    const rides = [ride('a', 'u2'), ride('b', 'u1'), ride('c', null), ride('d', 'u1'), ride('e', 'u3')];
    expect(sortWaitingForViewer(rides, 'u1').map((r) => r.id)).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('keeps the order when there is no viewer and does not mutate the input', () => {
    const rides = [ride('a', 'u2'), ride('b', null)];
    const copy = [...rides];
    expect(sortWaitingForViewer(rides, null).map((r) => r.id)).toEqual(['a', 'b']);
    expect(rides).toEqual(copy);
  });
});
