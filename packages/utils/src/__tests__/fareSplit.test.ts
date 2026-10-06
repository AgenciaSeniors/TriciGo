import { describe, it, expect } from 'vitest';
import { equalSplitSharePct, splitAmountTrc, requesterShareTrc } from '../fareSplit';

describe('equalSplitSharePct — the share the server gives each invitee (00613)', () => {
  it('splits evenly among the requester and the invitees, rounded down to 0.01 %', () => {
    expect(equalSplitSharePct(2)).toBe(50);
    expect(equalSplitSharePct(3)).toBe(33.33);
    expect(equalSplitSharePct(4)).toBe(25);
    expect(equalSplitSharePct(5)).toBe(20);
    expect(equalSplitSharePct(6)).toBe(16.66);
    expect(equalSplitSharePct(7)).toBe(14.28);
  });

  it('gives the whole fare to a lone requester and to a nonsense count', () => {
    expect(equalSplitSharePct(1)).toBe(100);
    expect(equalSplitSharePct(0)).toBe(100);
    expect(equalSplitSharePct(Number.NaN)).toBe(100);
  });
});

describe('splitAmountTrc — what complete_ride_and_pay charges a split', () => {
  it('rounds fare × share / 100 half up, like Postgres ROUND', () => {
    expect(splitAmountTrc(1000, 33.33)).toBe(333);
    expect(splitAmountTrc(1250, 33.33)).toBe(417); // 416.625
    expect(splitAmountTrc(1, 50)).toBe(1); // 0.5
    expect(splitAmountTrc(5000, 25)).toBe(1250);
  });

  it('reads the share as PostgREST may send a numeric: a string', () => {
    expect(splitAmountTrc(1000, '33.33')).toBe(333);
  });

  it('charges nothing for a missing or non-positive share', () => {
    expect(splitAmountTrc(1000, 0)).toBe(0);
    expect(splitAmountTrc(1000, Number.NaN)).toBe(0);
  });
});

describe('requesterShareTrc — "Tu parte" for whoever asked for the ride', () => {
  it('is the fare minus every invitee’s part: the requester absorbs the rounding', () => {
    expect(requesterShareTrc(1000, [{ share_pct: 33.33 }, { share_pct: 33.33 }])).toBe(334);
    expect(requesterShareTrc(1000, [{ share_pct: 25 }, { share_pct: 25 }, { share_pct: 25 }])).toBe(250);
  });

  it('is the whole fare with no invitees', () => {
    expect(requesterShareTrc(1000, [])).toBe(1000);
  });

  it('shows what the old app shares really left the requester', () => {
    // Before 00613 the apps sent 50 % and then 33.33 %, and the screen said
    // "Tu parte ~333" while the requester owed 167.
    expect(requesterShareTrc(1000, [{ share_pct: 50 }, { share_pct: 33.33 }])).toBe(167);
  });

  it('is never negative', () => {
    expect(requesterShareTrc(100, [{ share_pct: 100 }, { share_pct: 50 }])).toBe(0);
  });
});
