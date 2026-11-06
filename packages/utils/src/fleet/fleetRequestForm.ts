// ============================================================
// TriciGo — what the fleet request form checks before sending
// Plain TypeScript, so vitest can test it without a renderer. A phone
// that is not a Cuban mobile is saved and never links to anyone, and
// hours the time column refuses fail the request after its account
// exists, so both are caught here. The fields the button requires
// (name, city, vehicle types) are not: the form keeps the button off
// until they are filled in.
// ============================================================

import type { FleetMemberInput } from '@tricigo/types';
import { isValidCubanPhone, isValidEmail, normalizeCubanPhone } from '../validation';
import { fleetMemberErrorTexts } from './fleetMemberForm';

export interface FleetRequestFormFields {
  /**
   * The contact phone the owner typed. Left out when the session already has
   * one (the driver app, or a passenger who signed in with a phone); given,
   * even empty, it is required and must be a Cuban mobile.
   */
  ownerPhone?: string;
  responsibleEmail: string;
  hoursStart: string;
  hoursEnd: string;
  members: FleetMemberInput[];
}

export interface FleetRequestRowErrors {
  name?: 'required';
  phone?: 'required' | 'invalid';
  email?: 'invalid';
}

export interface FleetRequestFormErrors {
  ownerPhone?: 'required' | 'invalid';
  responsibleEmail?: 'invalid';
  hoursStart?: 'invalid';
  hoursEnd?: 'invalid';
  /** One entry per driver row of the form, in the same order. */
  members: FleetRequestRowErrors[];
}

export const noFleetRequestErrors: FleetRequestFormErrors = { members: [] };

/** Whether the form must ask for the contact phone: the session brings none. */
export function fleetOwnerPhoneIsAsked(sessionPhone: string | null | undefined): boolean {
  return !sessionPhone?.trim();
}

/**
 * The phone saved as the contact of the request: the session's, else the one
 * typed in E.164. It is never written to users.phone: the server reverts that
 * without an OTP (00599).
 */
export function fleetOwnerContactPhone(sessionPhone: string | null | undefined, typed: string): string {
  return fleetOwnerPhoneIsAsked(sessionPhone) ? normalizeCubanPhone(typed.trim()) : (sessionPhone as string);
}

const HOUR = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The HH:MM the time columns of driver_fleets accept. */
export function isValidFleetHour(value: string): boolean {
  return HOUR.test(value);
}

/** The vehicle types a fleet can list. `label` is the Spanish default of fleet.vehicle_type.<id>. */
export const FLEET_VEHICLE_TYPES = [
  { id: 'triciclo_basico', label: 'Triciclo' },
  { id: 'moto_standard', label: 'Moto' },
  { id: 'auto_standard', label: 'Auto' },
  { id: 'triciclo_cargo', label: 'Cargo' },
];

function rowErrors(row: FleetMemberInput): FleetRequestRowErrors {
  const name = row.driver_name.trim();
  const phone = row.driver_phone.trim();
  const email = row.driver_email?.trim() ?? '';
  const others = [row.driver_license_number, row.driver_id_number].some((value) => value?.trim());
  // An untouched row is not a driver: the request leaves it out.
  if (!name && !phone && !email && !others) return {};

  const errors: FleetRequestRowErrors = {};
  if (!name) errors.name = 'required';
  if (!phone) errors.phone = 'required';
  else if (!isValidCubanPhone(phone)) errors.phone = 'invalid';
  if (email && !isValidEmail(email)) errors.email = 'invalid';
  return errors;
}

/** What to fix before sending the request, or null when there is nothing to fix. */
export function validateFleetRequestForm(form: FleetRequestFormFields): FleetRequestFormErrors | null {
  const errors: FleetRequestFormErrors = { members: form.members.map(rowErrors) };

  if (form.ownerPhone !== undefined) {
    const ownerPhone = form.ownerPhone.trim();
    if (!ownerPhone) errors.ownerPhone = 'required';
    else if (!isValidCubanPhone(ownerPhone)) errors.ownerPhone = 'invalid';
  }
  const responsibleEmail = form.responsibleEmail.trim();
  if (responsibleEmail && !isValidEmail(responsibleEmail)) errors.responsibleEmail = 'invalid';
  const hoursStart = form.hoursStart.trim();
  if (hoursStart && !isValidFleetHour(hoursStart)) errors.hoursStart = 'invalid';
  const hoursEnd = form.hoursEnd.trim();
  if (hoursEnd && !isValidFleetHour(hoursEnd)) errors.hoursEnd = 'invalid';

  const fine =
    !errors.ownerPhone &&
    !errors.responsibleEmail &&
    !errors.hoursStart &&
    !errors.hoursEnd &&
    errors.members.every((row) => !row.name && !row.phone && !row.email);
  return fine ? null : errors;
}

export interface FleetRequestRowErrorTexts {
  name?: string;
  phone?: string;
  email?: string;
}

export interface FleetRequestErrorTexts {
  ownerPhone?: string;
  responsibleEmail?: string;
  hoursStart?: string;
  hoursEnd?: string;
  members: FleetRequestRowErrorTexts[];
}

type Translate = (key: string, options: { defaultValue: string; row?: number }) => string;

/** The message under each field at fault. */
export function fleetRequestErrorTexts(errors: FleetRequestFormErrors, t: Translate): FleetRequestErrorTexts {
  const emailText = () =>
    t('fleet.request_email_invalid', { defaultValue: 'Escribe un email válido, como nombre@ejemplo.com.' });

  const texts: FleetRequestErrorTexts = {
    members: errors.members.map((row) => {
      const rowTexts: FleetRequestRowErrorTexts = fleetMemberErrorTexts({ name: row.name, phone: row.phone }, t);
      if (row.email) rowTexts.email = emailText();
      return rowTexts;
    }),
  };
  if (errors.ownerPhone === 'required') {
    texts.ownerPhone = t('fleet.request_owner_phone_required', {
      defaultValue: 'Escribe tu teléfono de contacto.',
    });
  }
  if (errors.ownerPhone === 'invalid') {
    texts.ownerPhone = t('fleet.request_owner_phone_invalid', {
      defaultValue: 'Escribe un móvil cubano: 8 dígitos que empiezan por 5 o 6.',
    });
  }
  if (errors.responsibleEmail) texts.responsibleEmail = emailText();
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
  return texts;
}

/**
 * Every error in the order the form shows them, for a screen reader. Most of
 * the fields can be out of view, and the rows repeat the same labels, so each
 * message of a row says which driver it is about.
 */
export function fleetRequestAnnouncement(errors: FleetRequestFormErrors, t: Translate): string {
  const { ownerPhone, responsibleEmail, hoursStart, hoursEnd, members } = fleetRequestErrorTexts(errors, t);
  const parts = [ownerPhone, responsibleEmail, hoursStart, hoursEnd].filter(Boolean);
  members.forEach((row, index) => {
    const messages = [row.name, row.phone, row.email].filter(Boolean);
    if (messages.length === 0) return;
    const label = t('fleet.request_driver_row', { defaultValue: 'Conductor {{row}}', row: index + 1 });
    parts.push(`${label}: ${messages.join(' ')}`);
  });
  return parts.join(' ');
}
