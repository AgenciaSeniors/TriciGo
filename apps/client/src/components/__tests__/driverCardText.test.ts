import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@tricigo/i18n';
import { driverCardText } from '@tricigo/ui/driverCardText';
import { bootI18n } from '../../lib/i18nStartup';

beforeAll(() => {
  bootI18n();
});

// The QA round of 2026-11-17 found the driver card on "Viaje completado"
// reading "★ 5.0 · 1 viajes", with "plate QA-0141" in its accessibility label
// while the app was in Spanish. RideCompleteView and RideActiveView pass the
// card the same two strings built here.
function card(lng: 'es' | 'en' | 'pt', rides: number) {
  const t = i18n.getFixedT(lng, 'rider');
  return driverCardText({
    driverName: 'QA Moto',
    driverRating: 5,
    driverTotalRides: rides,
    vehicleYear: 2022,
    vehicleMake: 'Suzuki',
    vehicleModel: 'GN125',
    vehicleColor: 'Negro',
    vehiclePlate: 'QA-0141',
    ridesText: t('ride.driver_rides_count', { count: rides }),
    plateLabel: t('ride.plate_label'),
  });
}

describe('driver card text', () => {
  it.each([
    ['es', 1, '★ 5.0 · 1 viaje'],
    ['es', 312, '★ 5.0 · 312 viajes'],
    ['en', 1, '★ 5.0 · 1 ride'],
    ['en', 312, '★ 5.0 · 312 rides'],
    ['pt', 1, '★ 5.0 · 1 viagem'],
    ['pt', 312, '★ 5.0 · 312 viagens'],
  ] as const)('%s, %i rides: %s', (lng, rides, expected) => {
    expect(card(lng, rides).ratingLine).toBe(expected);
  });

  it('leaves the ride count out when the driver has none yet', () => {
    expect(card('es', 0).ratingLine).toBe('★ 5.0');
  });

  it.each([
    ['es', 'QA Moto, ★ 5.0 · 1 viaje, 2022 Suzuki GN125 · Negro, Placa QA-0141'],
    ['en', 'QA Moto, ★ 5.0 · 1 ride, 2022 Suzuki GN125 · Negro, Plate QA-0141'],
    ['pt', 'QA Moto, ★ 5.0 · 1 viagem, 2022 Suzuki GN125 · Negro, Placa QA-0141'],
  ] as const)('reads the plate in the app language (%s)', (lng, expected) => {
    expect(card(lng, 1).accessibilityLabel).toBe(expected);
  });
});

// DriverProfileScreen shows the count as a big number with the noun under it,
// so its label carries no number of its own.
describe('driver profile trips label', () => {
  it.each([
    ['es', 1, 'viaje'],
    ['es', 2, 'viajes'],
    ['en', 1, 'trip'],
    ['en', 2, 'trips'],
    ['pt', 1, 'viagem'],
    ['pt', 2, 'viagens'],
    // A driver with no rides yet. CLDR puts 0 in Portuguese's "one" category,
    // so without a _zero form the screen read "0 viagem".
    ['es', 0, 'viajes'],
    ['en', 0, 'trips'],
    ['pt', 0, 'viagens'],
  ] as const)('%s, %i: %s', (lng, count, expected) => {
    expect(i18n.getFixedT(lng, 'rider')('ride.driver_profile_trips', { count })).toBe(expected);
  });
});

// The card leaves the count out at 0, but the web version of the active ride
// (WebActiveRideView) shows it whenever the driver has a count.
describe('ride count phrase with no rides', () => {
  it.each([
    ['es', '0 viajes'],
    ['en', '0 rides'],
    ['pt', '0 viagens'],
  ] as const)('%s: %s', (lng, expected) => {
    expect(i18n.getFixedT(lng, 'rider')('ride.driver_rides_count', { count: 0 })).toBe(expected);
  });
});
