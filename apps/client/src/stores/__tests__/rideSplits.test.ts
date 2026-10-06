import { describe, it, expect } from 'vitest';
import type { RideSplit } from '@tricigo/types';
import { upsertSplit, withKnownNames } from '../rideSplits';

const split = (id: string, share_pct: number, extra: Partial<RideSplit> = {}): RideSplit => ({
  id,
  ride_id: 'r1',
  user_id: `u-${id}`,
  share_pct,
  amount_trc: null,
  payment_status: 'pending',
  invited_by: 'requester',
  accepted_at: null,
  paid_at: null,
  created_at: '2026-10-06T00:00:00Z',
  ...extra,
});

describe('upsertSplit — the invite result and its realtime INSERT both arrive', () => {
  it('adds a split it has not seen', () => {
    expect(upsertSplit([split('a', 50)], split('b', 33.33)).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('merges a split it already has instead of listing it twice', () => {
    const local = split('b', 33.33, { user_name: 'Beto', user_phone: '+5355555555' });
    const fromRealtime = split('b', 33.33);
    const list = upsertSplit([split('a', 33.33), local], fromRealtime);
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ id: 'b', user_name: 'Beto', user_phone: '+5355555555' });
  });
});

describe('withKnownNames — re-reading the splits keeps what the screen already knew', () => {
  it('keeps the typed phone and name the server read does not carry', () => {
    const known = [split('b', 50, { user_name: 'Beto', user_phone: '+5355555555' })];
    const fresh = [split('b', 33.33), split('c', 33.33, { user_name: 'Eva' })];
    expect(withKnownNames(fresh, known)).toEqual([
      split('b', 33.33, { user_name: 'Beto', user_phone: '+5355555555' }),
      split('c', 33.33, { user_name: 'Eva' }),
    ]);
  });

  it('takes the server name over the local one', () => {
    const known = [split('b', 50, { user_name: 'beto' })];
    expect(withKnownNames([split('b', 33.33, { user_name: 'Beto Pérez' })], known)[0]?.user_name).toBe('Beto Pérez');
  });
});
