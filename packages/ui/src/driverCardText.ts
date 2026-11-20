// Text shown by DriverCard, kept out of the component so it can be tested
// without a React Native renderer. All wording comes from the caller already
// translated: this file adds no words of its own, only the layout.

export interface DriverCardTextInput {
  driverName: string;
  driverRating?: number | null;
  driverTotalRides?: number | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  vehicleColor?: string | null;
  vehiclePlate?: string | null;
  vehicleYear?: number | null;
  /**
   * The ride count as a whole phrase, number included ("312 viajes",
   * "1 viaje"). Translations differ in more than the noun, so the caller
   * builds it with i18next plurals instead of passing a word to append.
   */
  ridesText?: string;
  /** Word read before the plate by screen readers ("Placa", "Plate"). */
  plateLabel?: string;
}

export interface DriverCardText {
  /** "★ 4.8 · 312 viajes". Empty when there is neither rating nor rides. */
  ratingLine: string;
  /** "2021 Honda Wave · Azul". */
  vehicleLine: string;
  accessibilityLabel: string;
}

export function driverCardText(input: DriverCardTextInput): DriverCardText {
  const vehicleParts: string[] = [];
  if (input.vehicleYear) vehicleParts.push(String(input.vehicleYear));
  if (input.vehicleMake) vehicleParts.push(input.vehicleMake);
  if (input.vehicleModel) vehicleParts.push(input.vehicleModel);
  const vehicleDesc = vehicleParts.join(' ');
  const vehicleLine = input.vehicleColor ? `${vehicleDesc} · ${input.vehicleColor}` : vehicleDesc;

  const ratingParts: string[] = [];
  if (input.driverRating != null) ratingParts.push(`★ ${input.driverRating.toFixed(1)}`);
  if (input.ridesText && input.driverTotalRides != null && input.driverTotalRides > 0) {
    ratingParts.push(input.ridesText);
  }
  const ratingLine = ratingParts.join(' · ');

  const plate = input.vehiclePlate
    ? [input.plateLabel, input.vehiclePlate].filter(Boolean).join(' ')
    : '';
  const accessibilityLabel = [input.driverName, ratingLine, vehicleLine, plate]
    .filter(Boolean)
    .join(', ');

  return { ratingLine, vehicleLine, accessibilityLabel };
}
