/**
 * Safe star-rating formatter.
 *
 * Why this exists: `rating_avg` (drivers) and `users.rating_avg` (riders) are
 * typed as `number` but can be `null` at runtime for a brand-new account with
 * no reviews (the reputation rework averages over an empty set → NULL). When a
 * presence payload carried `rating: undefined`, rider/driver screens did a raw
 * `value.toFixed(1)` → "Cannot read property 'toFixed' of undefined" (Hermes).
 *
 * `formatRating` guards once, here, so every call site is crash-proof. Pass a
 * localized fallback (e.g. "Nuevo") for unrated accounts; the default "—" suits
 * a user's own self-summary where a number is simply not available yet.
 */
export function formatRating(
  value: number | null | undefined,
  fallback = '—',
): string {
  return Number.isFinite(value as number) ? (value as number).toFixed(1) : fallback;
}
