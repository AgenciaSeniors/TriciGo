// ============================================================
// TriciGo — WhatsApp texts support sends from the ride assist page
//
// The rider and the driver do not know the ride's internal code
// (rides.code), so the text names the trip by the place they will
// recognise: the destination for the rider, the pickup or the
// destination for the driver, depending on where the ride is.
// These pick the admin.json key and its variables; the page runs
// them through t() and waMeLink().
// ============================================================

import { isPlaceholderAddress } from './geo';

export interface AssistWhatsAppMessage {
  /** Key in the admin namespace. */
  key: string;
  vars: Record<string, string>;
}

/** Statuses where the driver is still on the way to the rider. */
const BEFORE_PICKUP = new Set(['accepted', 'driver_en_route', 'arrived_at_pickup']);

/**
 * The part of an address a person recognises at a glance: the first segment before a comma
 * ("Avenida 37 e/ 46 y 48, Playa, La Habana" gives "Avenida 37 e/ 46 y 48"). A leading
 * "Cerca de" goes, since the text reads "hacia <place>". Null when the address names no
 * place: empty, raw coordinates or a UI placeholder.
 */
export function shortAddress(address: string | null | undefined): string | null {
  if (isPlaceholderAddress(address)) return null;
  for (const segment of (address ?? '').split(',')) {
    const head = segment.replace(/\s+/g, ' ').trim().replace(/^cerca de(\s+|$)/i, '');
    if (head) return head;
  }
  return null;
}

/** The rider's text: their ride by its destination, or no place at all. */
export function riderAssistMessage(dropoffAddress: string | null | undefined): AssistWhatsAppMessage {
  const destination = shortAddress(dropoffAddress);
  return destination
    ? { key: 'ride_assist.rider_whatsapp_text', vars: { destination } }
    : { key: 'ride_assist.rider_whatsapp_text_no_destination', vars: {} };
}

/**
 * The text for the driver of a ride in progress. Before the pickup the driver is heading to the
 * rider, so the pickup names the ride; after it, the destination. When that address is empty the
 * other one still identifies the ride.
 */
export function activeDriverAssistMessage(
  status: string,
  pickupAddress: string | null | undefined,
  dropoffAddress: string | null | undefined,
): AssistWhatsAppMessage {
  const pickup = shortAddress(pickupAddress);
  const destination = shortAddress(dropoffAddress);
  const byPickup: AssistWhatsAppMessage | null = pickup
    ? { key: 'ride_assist.active_driver_whatsapp_text_pickup', vars: { pickup } }
    : null;
  const byDestination: AssistWhatsAppMessage | null = destination
    ? { key: 'ride_assist.active_driver_whatsapp_text_destination', vars: { destination } }
    : null;
  const [first, second] = BEFORE_PICKUP.has(status) ? [byPickup, byDestination] : [byDestination, byPickup];
  return first ?? second ?? { key: 'ride_assist.active_driver_whatsapp_text_no_address', vars: {} };
}
