import type { RideSplit } from '@tricigo/types';

/**
 * Adds a split to the list, or merges it into the one with the same id. The
 * requester's own invite result and the realtime INSERT for it both arrive;
 * listed twice, the split would also be subtracted twice from "Tu parte".
 */
export function upsertSplit(splits: RideSplit[], split: RideSplit): RideSplit[] {
  if (!splits.some((s) => s.id === split.id)) return [...splits, split];
  return splits.map((s) => (s.id === split.id ? { ...s, ...stripUndefined(split) } : s));
}

/**
 * The splits as just read from the server, keeping the name and the typed
 * phone the screen already had for each one (the read only carries names).
 */
export function withKnownNames(fresh: RideSplit[], known: RideSplit[]): RideSplit[] {
  const byId = new Map(known.map((s) => [s.id, s] as const));
  return fresh.map((s) => {
    const k = byId.get(s.id);
    if (!k) return s;
    const merged = { ...s, user_name: s.user_name ?? k.user_name, user_phone: s.user_phone ?? k.user_phone };
    return stripUndefined(merged);
  });
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
