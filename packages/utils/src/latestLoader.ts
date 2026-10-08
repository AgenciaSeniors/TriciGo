/**
 * Keeps the newest answer of a load that several triggers start: a screen regaining
 * focus, the app returning to the foreground, a sign-in, a pull-to-refresh.
 *
 * - A trigger while the same key is already loading is skipped, and it does not void
 *   the load in flight (the mistake this replaces: taking a new sequence number before
 *   the in-flight check dropped every first load).
 * - An answer for an older request, or for another key (an account switch or a
 *   sign-out), is dropped.
 */
export interface LatestLoader {
  /** A ticket for a new load, or null when the load should not start (same key in flight, or no key). */
  begin(key: string | null): number | null;
  /** Call when the load settles; true when its answer is the newest and should be applied. */
  settle(ticket: number, key: string): boolean;
  /** Forget the load in flight so the next begin() loads again (e.g. right after a write). */
  reset(): void;
}

export function createLatestLoader(): LatestLoader {
  let seq = 0;
  let inflightKey: string | null = null;
  return {
    begin(key) {
      if (key === null) {
        seq += 1;
        inflightKey = null;
        return null;
      }
      if (inflightKey === key) return null;
      seq += 1;
      inflightKey = key;
      return seq;
    },
    settle(ticket, key) {
      const newest = ticket === seq;
      if (newest && inflightKey === key) inflightKey = null;
      return newest;
    },
    reset() {
      inflightKey = null;
    },
  };
}
