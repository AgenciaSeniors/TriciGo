import { describe, it, expect } from 'vitest';
import { isCargoRide, deliveryVehicleToSlug } from '../delivery';

// The driver's active-trip badge asked `service_type === 'triciclo_cargo'`,
// which is never the service type of a mensajería order: those are stored with
// the chosen VEHICLE's slug plus ride_mode='cargo'. So the badge never appeared,
// while the delivery details card rendered right above it from the correct
// check. These cases pin the shape that actually reaches both surfaces.
describe('isCargoRide', () => {
  it('recognises a delivery by ride_mode, whatever vehicle carries it', () => {
    for (const service_type of ['moto_standard', 'triciclo_basico', 'auto_standard', 'auto_confort']) {
      expect(isCargoRide({ service_type, ride_mode: 'cargo' })).toBe(true);
    }
  });

  it('still recognises the cargo-only tricycle service slug', () => {
    expect(isCargoRide({ service_type: 'triciclo_cargo', ride_mode: 'passenger' })).toBe(true);
  });

  it('does not mistake a passenger ride for a delivery', () => {
    expect(isCargoRide({ service_type: 'moto_standard', ride_mode: 'passenger' })).toBe(false);
    expect(isCargoRide({ service_type: 'triciclo_basico', ride_mode: 'passenger' })).toBe(false);
  });

  it('is the exact check the old badge got wrong', () => {
    // A real mensajería order, as production stores it.
    const delivery = { service_type: 'moto_standard', ride_mode: 'cargo' };
    expect(delivery.service_type === 'triciclo_cargo').toBe(false); // what the badge asked
    expect(isCargoRide(delivery)).toBe(true); // what it should have asked
  });

  it('survives a missing or partial ride without throwing', () => {
    expect(isCargoRide(null)).toBe(false);
    expect(isCargoRide(undefined)).toBe(false);
    expect(isCargoRide({})).toBe(false);
    expect(isCargoRide({ ride_mode: null, service_type: null })).toBe(false);
  });
});

describe('deliveryVehicleToSlug', () => {
  it('maps every vehicle to the slug its delivery is priced and matched with', () => {
    expect(deliveryVehicleToSlug('moto')).toBe('moto_standard');
    expect(deliveryVehicleToSlug('triciclo')).toBe('triciclo_basico');
    expect(deliveryVehicleToSlug('auto')).toBe('auto_standard');
    // confort prices at confort rates; find_best_drivers pools auto% so it
    // still dispatches across auto and confort drivers.
    expect(deliveryVehicleToSlug('confort')).toBe('auto_confort');
  });

  it('never yields the mensajeria pseudo-slug, which no ride is stored with', () => {
    for (const v of ['moto', 'triciclo', 'auto', 'confort'] as const) {
      expect(deliveryVehicleToSlug(v)).not.toBe('mensajeria');
    }
  });
});
