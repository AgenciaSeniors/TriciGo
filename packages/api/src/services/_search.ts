/** Escape special characters for PostgreSQL ILIKE patterns. */
export function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, '\\$&');
}

/**
 * A ride code as riders and support write it ("F1A2B3C4", "#f1a2b3c4"): the first 8 hex
 * characters of the ride id, lower-cased. null when the text is not one.
 */
export function rideCodePrefix(text: string): string | null {
  const m = text.trim().match(/^#?([0-9a-f]{8})$/i);
  return m ? m[1]!.toLowerCase() : null;
}
