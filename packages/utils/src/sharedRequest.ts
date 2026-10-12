/**
 * One request for several callers that want the same data at about the same time.
 *
 * The admin panel's header bell and its dashboard both poll the dashboard metrics
 * on their own timers, and both start when the page opens: two identical requests
 * at once (2026-10-12). Each caller says how old an answer it accepts; within that
 * age it gets the answer (or the request still in flight) instead of a new one.
 * A failed request is forgotten, so the next caller asks again.
 */
export type SharedRequest = <T>(key: string, maxAgeMs: number, load: () => Promise<T>) => Promise<T>;

export function createSharedRequests(now: () => number = Date.now): SharedRequest {
  const entries = new Map<string, { at: number; promise: Promise<unknown> }>();

  return function shared<T>(key: string, maxAgeMs: number, load: () => Promise<T>): Promise<T> {
    const hit = entries.get(key);
    if (hit && now() - hit.at < maxAgeMs) return hit.promise as Promise<T>;

    const promise = load();
    const entry = { at: now(), promise };
    entries.set(key, entry);
    promise.catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
    return promise;
  };
}
