// ============================================================
// TriciGo — the form that edits the details of a fleet
// Plain TypeScript, so vitest can test it without a renderer. It
// follows the request form: the same HH:MM check, and name, city and
// a vehicle type are required. The notes are not editable here (the
// request keeps "Responsable: ..." in them), so the patch never
// carries them.
// ============================================================

import type { DriverFleet, FleetDetailsPatch } from '@tricigo/types';
import { isValidFleetHour } from './fleetRequestForm';

export interface FleetEditFormValues {
  name: string;
  city: string;
  vehicleTypes: string[];
  vehicleCount: string;
  /** Comma-separated, as typed. */
  zones: string;
  hoursStart: string;
  hoursEnd: string;
  ridesPerDay: string;
}

export interface FleetEditFormErrors {
  name?: 'required';
  city?: 'required';
  vehicleTypes?: 'required';
  vehicleCount?: 'invalid';
  ridesPerDay?: 'invalid';
  hoursStart?: 'invalid';
  hoursEnd?: 'invalid';
}

export type ParsedFleetEditForm =
  | { ok: true; patch: FleetDetailsPatch }
  | { ok: false; errors: FleetEditFormErrors };

// The time columns come back as HH:MM:SS.
function hourField(value: string | null): string {
  return value ? value.slice(0, 5) : '';
}

/** The form as the fleet has it today. */
export function fleetEditFormFromFleet(fleet: DriverFleet): FleetEditFormValues {
  return {
    name: fleet.name,
    city: fleet.city ?? '',
    vehicleTypes: [...fleet.vehicle_types],
    vehicleCount: fleet.vehicle_count_estimate?.toString() ?? '',
    zones: fleet.operating_zones.join(', '),
    hoursStart: hourField(fleet.operating_hours_start),
    hoursEnd: hourField(fleet.operating_hours_end),
    ridesPerDay: fleet.estimated_rides_per_day_per_vehicle?.toString() ?? '',
  };
}

// An empty count clears the column; anything else is a whole number of 1 or more.
function parseCount(value: string): { value: number | null } | 'invalid' {
  const text = value.trim();
  if (!text) return { value: null };
  if (!/^\d+$/.test(text) || Number(text) < 1) return 'invalid';
  return { value: Number(text) };
}

/** What the owner typed as the new details, or what to fix first. */
export function parseFleetEditForm(form: FleetEditFormValues): ParsedFleetEditForm {
  const name = form.name.trim();
  const city = form.city.trim();
  const hoursStart = form.hoursStart.trim();
  const hoursEnd = form.hoursEnd.trim();
  const count = parseCount(form.vehicleCount);
  const rides = parseCount(form.ridesPerDay);

  const errors: FleetEditFormErrors = {};
  if (!name) errors.name = 'required';
  if (!city) errors.city = 'required';
  if (form.vehicleTypes.length === 0) errors.vehicleTypes = 'required';
  if (count === 'invalid') errors.vehicleCount = 'invalid';
  if (rides === 'invalid') errors.ridesPerDay = 'invalid';
  if (hoursStart && !isValidFleetHour(hoursStart)) errors.hoursStart = 'invalid';
  if (hoursEnd && !isValidFleetHour(hoursEnd)) errors.hoursEnd = 'invalid';
  if (Object.keys(errors).length > 0 || count === 'invalid' || rides === 'invalid') return { ok: false, errors };

  return {
    ok: true,
    patch: {
      name,
      city,
      vehicle_types: form.vehicleTypes,
      vehicle_count_estimate: count.value,
      operating_zones: form.zones
        .split(',')
        .map((zone) => zone.trim())
        .filter(Boolean),
      estimated_rides_per_day_per_vehicle: rides.value,
      operating_hours_start: hoursStart || null,
      operating_hours_end: hoursEnd || null,
    },
  };
}

type Translate = (key: string, options: { defaultValue: string }) => string;

export interface FleetEditErrorTexts {
  name?: string;
  city?: string;
  vehicleTypes?: string;
  vehicleCount?: string;
  ridesPerDay?: string;
  hoursStart?: string;
  hoursEnd?: string;
}

/** The message under each field at fault, in the order the form shows them. */
export function fleetEditErrorTexts(errors: FleetEditFormErrors, t: Translate): FleetEditErrorTexts {
  const texts: FleetEditErrorTexts = {};
  if (errors.name) texts.name = t('fleet.edit_name_required', { defaultValue: 'Escribe el nombre de la flota.' });
  if (errors.city) texts.city = t('fleet.edit_city_required', { defaultValue: 'Escribe la ciudad o el municipio principal.' });
  if (errors.vehicleTypes) {
    texts.vehicleTypes = t('fleet.edit_vehicle_types_required', { defaultValue: 'Elige al menos un tipo de vehículo.' });
  }
  if (errors.vehicleCount) {
    texts.vehicleCount = t('fleet.edit_number_invalid', { defaultValue: 'Escribe un número entero mayor que 0.' });
  }
  if (errors.hoursStart) {
    texts.hoursStart = t('fleet.request_hours_start_invalid', {
      defaultValue: 'Hora de inicio: usa el formato HH:MM, por ejemplo 06:00.',
    });
  }
  if (errors.hoursEnd) {
    texts.hoursEnd = t('fleet.request_hours_end_invalid', {
      defaultValue: 'Hora de cierre: usa el formato HH:MM, por ejemplo 22:00.',
    });
  }
  if (errors.ridesPerDay) {
    texts.ridesPerDay = t('fleet.edit_number_invalid', { defaultValue: 'Escribe un número entero mayor que 0.' });
  }
  return texts;
}
