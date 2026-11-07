import { describe, it, expect } from 'vitest';
import type { DriverFleet } from '@tricigo/types';
import { fleetEditFormFromFleet, parseFleetEditForm, type FleetEditFormValues } from '../fleetEditForm';

const FLEET = {
  id: 'f1',
  corporate_account_id: 'c1',
  name: 'TaxiHabana',
  city: 'La Habana',
  vehicle_count_estimate: 12,
  vehicle_types: ['triciclo_basico', 'moto_standard'],
  operating_zones: ['Vedado', 'Miramar'],
  estimated_rides_per_day_per_vehicle: 8,
  operating_hours_start: '06:00:00',
  operating_hours_end: '22:00',
  notes: 'Responsable: Ana',
  created_at: '',
  updated_at: '',
} as DriverFleet;

function form(overrides: Partial<FleetEditFormValues> = {}): FleetEditFormValues {
  return { ...fleetEditFormFromFleet(FLEET), ...overrides };
}

describe('fleetEditFormFromFleet', () => {
  it('prefills every field, with the hours as HH:MM', () => {
    expect(fleetEditFormFromFleet(FLEET)).toEqual({
      name: 'TaxiHabana',
      city: 'La Habana',
      vehicleTypes: ['triciclo_basico', 'moto_standard'],
      vehicleCount: '12',
      zones: 'Vedado, Miramar',
      hoursStart: '06:00',
      hoursEnd: '22:00',
      ridesPerDay: '8',
    });
  });

  it('turns nulls into empty fields', () => {
    const empty = { ...FLEET, city: null, vehicle_count_estimate: null, operating_hours_start: null } as DriverFleet;
    expect(fleetEditFormFromFleet(empty)).toMatchObject({ city: '', vehicleCount: '', hoursStart: '' });
  });
});

describe('parseFleetEditForm', () => {
  it('builds the patch, trimmed, and never touches the notes', () => {
    const parsed = parseFleetEditForm(form({ name: '  Nueva  ', zones: 'Cerro,  Playa ,' }));
    expect(parsed).toEqual({
      ok: true,
      patch: {
        name: 'Nueva',
        city: 'La Habana',
        vehicle_types: ['triciclo_basico', 'moto_standard'],
        vehicle_count_estimate: 12,
        operating_zones: ['Cerro', 'Playa'],
        estimated_rides_per_day_per_vehicle: 8,
        operating_hours_start: '06:00',
        operating_hours_end: '22:00',
      },
    });
    expect(Object.keys((parsed as { patch: object }).patch)).not.toContain('notes');
  });

  it('clears an optional field left empty', () => {
    const parsed = parseFleetEditForm(form({ vehicleCount: '', ridesPerDay: ' ', hoursStart: '', hoursEnd: '', zones: '' }));
    expect(parsed).toMatchObject({
      ok: true,
      patch: {
        vehicle_count_estimate: null,
        estimated_rides_per_day_per_vehicle: null,
        operating_hours_start: null,
        operating_hours_end: null,
        operating_zones: [],
      },
    });
  });

  it('requires name, city and a vehicle type, like the request form', () => {
    const parsed = parseFleetEditForm(form({ name: ' ', city: '', vehicleTypes: [] }));
    expect(parsed).toEqual({
      ok: false,
      errors: { name: 'required', city: 'required', vehicleTypes: 'required' },
    });
  });

  it('uses the same HH:MM check as the request form', () => {
    for (const bad of ['6:00', '24:00', '12:60', '0600', 'abc']) {
      expect(parseFleetEditForm(form({ hoursStart: bad }))).toMatchObject({ ok: false, errors: { hoursStart: 'invalid' } });
    }
    expect(parseFleetEditForm(form({ hoursEnd: '23:59' })).ok).toBe(true);
  });

  it('refuses counts that are not whole positive numbers', () => {
    for (const bad of ['0', '-3', '2.5', 'doce']) {
      expect(parseFleetEditForm(form({ vehicleCount: bad }))).toMatchObject({ ok: false, errors: { vehicleCount: 'invalid' } });
      expect(parseFleetEditForm(form({ ridesPerDay: bad }))).toMatchObject({ ok: false, errors: { ridesPerDay: 'invalid' } });
    }
  });
});
