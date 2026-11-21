/**
 * The address the pin-confirmation map keeps when the rider confirms without moving the pin.
 *
 * 00537: for a street, the text the rider picked in search ("Calle 3ra e/ 4 y 2, Vedado") is
 * richer than the reverse geocode of the same point, so it is kept. For a zone (a neighbourhood
 * or municipality) it is the other way round: the zone name is what the confirmation exists to
 * replace, and the map already shows the exact address of the pin (QA R4-02).
 */
export function pickerInitialAddress(
  picker: { keepAddress: boolean; zoneHint?: boolean },
  draftAddress: string | null | undefined,
): string | null {
  if (!picker.keepAddress || picker.zoneHint) return null;
  return draftAddress ?? null;
}
