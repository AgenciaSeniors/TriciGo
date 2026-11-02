// DUPLICATE of cubaTimeZone in packages/utils/src/date.ts (Edge Functions run
// on Deno and do not import @tricigo/utils). Keep both, and public.cuba_tz()
// in SQL, in sync.
//
// Cuba kept summer time (UTC−4) from 2026-11-01 until 2027-11-07, while
// tzdata still falls back to UTC−5 on 2026-11-01, so 'America/Havana' reads
// an hour behind until March 2027. Inside that span Cuba's clock equals
// America/Santo_Domingo (UTC−4 all year, no DST); outside it tzdata is right.

export const CUBA_SUMMER_TIME_EXTENSION = {
  startMs: Date.UTC(2026, 10, 1, 5, 0, 0),
  endMs: Date.UTC(2027, 10, 7, 5, 0, 0),
} as const;

/** The IANA zone that shows Cuba's official clock at an instant (default: now). */
export function cubaTimeZone(at?: Date | number | string | null): string {
  const ms =
    at == null ? Date.now() : at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return 'America/Havana';
  return ms >= CUBA_SUMMER_TIME_EXTENSION.startMs && ms < CUBA_SUMMER_TIME_EXTENSION.endMs
    ? 'America/Santo_Domingo'
    : 'America/Havana';
}
