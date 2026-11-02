// ============================================================
// TriciGo — the server's clock, as seen from this device
//
// Some decisions compare a server timestamp with "now": whether a driver's
// ride offer is still open (ride_offers.expires_at, a 60 s window) is the
// important one. Read with the phone's Date.now(), a phone set an hour ahead
// (2026-11-01, see clockSafeAuth.ts) sees every offer as expired the moment it
// arrives and the card vanishes. serverNowMs() corrects for that.
//
// The offset comes from the `Date` header of every Supabase response (the
// shared fetch calls noteServerDate). It has one-second resolution, so offsets
// under SKEW_THRESHOLD_MS are treated as zero: a phone within half a minute of
// the server keeps using its own clock exactly as before, and only a clock
// that is really wrong gets corrected. Without a readable header (a browser
// hides `Date` unless the server exposes it) the offset stays at zero.
// ============================================================

const SKEW_THRESHOLD_MS = 30_000;

let offsetMs = 0;

/** Record the server time a response carried. `receivedAtMs` is the device's Date.now() then. */
export function noteServerDate(header: string | null | undefined, receivedAtMs: number = Date.now()): void {
  if (!header) return;
  const serverMs = Date.parse(header);
  if (!Number.isFinite(serverMs)) return;
  // The header truncates to the second: the server was somewhere in [s, s + 1).
  const sample = serverMs + 500 - receivedAtMs;
  offsetMs = Math.abs(sample) >= SKEW_THRESHOLD_MS ? sample : 0;
}

/** How far the server's clock is ahead of this device's (negative when behind). Zero when within 30 s. */
export function serverClockOffsetMs(): number {
  return offsetMs;
}

/** The server's current time, in ms since the epoch. */
export function serverNowMs(): number {
  return Date.now() + offsetMs;
}

/** Test helper. */
export function resetServerClock(): void {
  offsetMs = 0;
}
