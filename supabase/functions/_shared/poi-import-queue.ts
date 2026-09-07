// supabase/functions/_shared/poi-import-queue.ts
// Pure state machine for the import-mapbox-poi {drain:N} worker (00584).
// No Deno / remote imports so packages/api's vitest can run it.

export const MAX_DRAIN_ATTEMPTS = 2;

export type DrainOutcome =
  | { kind: 'imported'; poiId: number; reason: string }
  | { kind: 'matched'; poiId: number; reason: string; bump?: boolean }
  | { kind: 'no_match'; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'error'; reason: string };

export interface QueueUpdate {
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  poi_id: number | null;
  reason: string;
  /** true → call bump_poi_pick(poi_id): the rider really went there. */
  bump: boolean;
}

export function nextQueueState(attempts: number, outcome: DrainOutcome): QueueUpdate {
  const next = attempts + 1;
  switch (outcome.kind) {
    case 'imported':
      return { status: 'done', attempts: next, poi_id: outcome.poiId, reason: outcome.reason, bump: true };
    case 'matched':
      return { status: 'done', attempts: next, poi_id: outcome.poiId, reason: outcome.reason, bump: outcome.bump ?? true };
    case 'rejected':
      return { status: 'failed', attempts: next, poi_id: null, reason: outcome.reason, bump: false };
    case 'no_match':
    case 'error':
      return {
        status: next >= MAX_DRAIN_ATTEMPTS ? 'failed' : 'pending',
        attempts: next,
        poi_id: null,
        reason: outcome.reason,
        bump: false,
      };
  }
}

export function clampDrainSize(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 20;
  return Math.min(50, Math.max(1, Math.floor(n)));
}
