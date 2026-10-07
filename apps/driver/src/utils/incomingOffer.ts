/**
 * What the offers list does with a ride offer it hears about (the 30 s poll or realtime).
 *
 * The same offer arrives many times (realtime, then every poll), so the list used to keep the
 * first copy of a ride and drop the rest. That hid what support does to a live offer (00628):
 * "Enviar oferta" extends it or re-arms it, and a type change re-offers it at the new price. Each
 * gives the offer a LATER expires_at than the copy the app holds, and the expiry is the only thing
 * the app can tell them apart by:
 *
 * - 'add': show it as a new offer (top of the list, with a notification): one the app has never
 *   heard of, or a copy on screen that had already lapsed.
 * - 'replace': the copy on screen is still live; refresh it in place (expiry, type, price).
 * - 'ignore': the same offer heard again, or a ride the driver refused.
 *
 * A refusal ("No me sirve") holds for the session, whatever the expiry: the normal re-offer
 * re-arms a refused offer every few minutes with a later expiry too, and that must not bring the
 * card back. For a driver who refused it, support assigns the ride directly. A missing or
 * unreadable expiry never counts as later, so the cached copy holds.
 */
export type IncomingOfferAction = 'add' | 'replace' | 'ignore';

/** The copy of the offer already in the list. */
export interface CachedOffer {
  /** Its offer_expires_at (ride_offers.expires_at). */
  expiresAt: string | null | undefined;
}

function expiryMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isLater(candidate: string | null | undefined, reference: string | null | undefined): boolean {
  const c = expiryMs(candidate);
  const r = expiryMs(reference);
  return c !== null && r !== null && c > r;
}

export function decideIncomingOffer(
  incomingExpiresAt: string | null | undefined,
  cached: CachedOffer | null,
  dismissed: boolean,
  now: number,
): IncomingOfferAction {
  if (dismissed) return 'ignore';
  if (!cached) return 'add';
  if (!isLater(incomingExpiresAt, cached.expiresAt)) return 'ignore';
  const cachedMs = expiryMs(cached.expiresAt);
  return cachedMs !== null && cachedMs <= now ? 'add' : 'replace';
}
