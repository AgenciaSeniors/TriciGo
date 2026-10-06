// ============================================================
// The SOS SMS that broadcast-emergency sends to a user's trusted contacts.
//
// Every value in the text comes from the database, never from the request
// (2026-10-06). Before, the app sent rider_name, driver_name and
// vehicle_plate and the function pasted them into the SMS unchecked, so any
// account could send texts of its choosing, signed "TriciGo", to numbers it
// put in its own trusted contacts. This module only formats; the EF looks up
// the caller's name and, for a ride the caller is the passenger of, the
// driver's name and plate, and reduces names to first name and initial.
//
// Pure module with no remote imports, so packages/api's vitest runs its test.
// ============================================================

export type SosLocale = 'es' | 'en' | 'pt';

export interface SosFields {
  latitude: number;
  longitude: number;
  riderName: string | null;
  driverName: string | null;
  vehiclePlate: string | null;
  /** First 8 characters of the ride id, only for a ride the caller is part of. */
  rideRef: string | null;
}

/** Trims, collapses whitespace, drops control characters and caps the length. */
export function cleanSmsField(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // deno-lint-ignore no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

/**
 * A person's name as it may appear in an SOS SMS: first name and the initial
 * of the next word, letters only ("Ana María Pérez" → "Ana M."). full_name is
 * written by its owner, so the full value would still let an account put up
 * to 40 characters of its own text, a link included, in a text signed TriciGo.
 */
export function smsPersonName(fullName: unknown): string | null {
  if (typeof fullName !== 'string') return null;
  const words = fullName
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}'-]/gu, ''))
    .filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return null;
  const first = Array.from(words[0]).slice(0, 20).join('');
  if (words.length === 1) return first;
  return `${first} ${Array.from(words[1])[0].toUpperCase()}.`;
}

export function validCoordinates(latitude: unknown, longitude: unknown): boolean {
  return typeof latitude === 'number' && typeof longitude === 'number'
    && Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

export function buildSosSmsBody(f: SosFields, locale: SosLocale): string {
  const mapsUrl = `https://maps.google.com/?q=${f.latitude.toFixed(6)},${f.longitude.toFixed(6)}`;
  const riderName = f.riderName || 'Un usuario de TriciGo';
  const driverInfo = f.driverName || f.vehiclePlate
    ? ` Conductor: ${[f.driverName, f.vehiclePlate].filter(Boolean).join(' / ')}.`
    : '';
  const rideRef = f.rideRef ? ` Ride: ${f.rideRef}.` : '';

  // No leading emoji: carriers silently filter 🚨-led alert SMS even with a
  // 'delivered' DLR (A/B verified 2026-07-02; see migration 00475).
  if (locale === 'en') {
    return `EMERGENCY: ${riderName} sent an SOS via TriciGo. Location: ${mapsUrl}${driverInfo}${rideRef}`;
  }
  if (locale === 'pt') {
    return `EMERGÊNCIA: ${riderName} enviou um SOS pelo TriciGo. Local: ${mapsUrl}${driverInfo}${rideRef}`;
  }
  return `EMERGENCIA: ${riderName} envió un SOS desde TriciGo. Ubicación: ${mapsUrl}${driverInfo}${rideRef}`;
}
