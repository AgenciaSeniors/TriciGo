// ============================================================
// TriciGo — Rider notes for the driver ("#302 apto 4, edificio azul,
// tocar el timbre"). One free-text field per endpoint, stored on the ride
// (rides.pickup_notes / rides.dropoff_notes, migration 00578).
// ============================================================

/** Column limit — mirrors the CHECK constraint in 00578. */
export const ADDRESS_NOTES_MAX = 200;

/**
 * Normalise a note before it leaves the device: trim, collapse runs of
 * spaces, drop empty lines, keep intentional line breaks, cap at the column
 * limit so an over-long paste can never fail the insert. Empty → null so the
 * column stays NULL (the driver UI hides the block on null).
 */
export function trimNotes(s: string | null | undefined): string | null {
  if (!s) return null;
  const cleaned = s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > ADDRESS_NOTES_MAX ? cleaned.slice(0, ADDRESS_NOTES_MAX) : cleaned;
}
