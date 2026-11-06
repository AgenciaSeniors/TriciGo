// ============================================================
// TriciGo — the form that adds a driver to a fleet
// Plain TypeScript, so vitest can test it without a renderer. The
// duplicate check is not here: it needs the fleet's rows, so
// fleetService.addMember does it.
// ============================================================

import type { FleetMemberInput } from '@tricigo/types';
import { isValidCubanPhone } from '../validation';

export interface FleetMemberFormValues {
  name: string;
  phone: string;
  email: string;
  license: string;
  idNumber: string;
}

export const emptyFleetMemberForm: FleetMemberFormValues = {
  name: '',
  phone: '',
  email: '',
  license: '',
  idNumber: '',
};

export interface FleetMemberFormErrors {
  name?: 'required';
  phone?: 'required' | 'invalid';
}

export type ParsedFleetMemberForm =
  | { ok: true; member: FleetMemberInput }
  | { ok: false; errors: FleetMemberFormErrors };

export interface FleetMemberErrorTexts {
  name?: string;
  phone?: string;
}

type Translate = (key: string, options: { defaultValue: string }) => string;

/**
 * The message for each field at fault, in the order the form shows them.
 * The screen prints them under the fields and reads them out, so a screen
 * reader user hears what to fix without finding the field first.
 */
export function fleetMemberErrorTexts(errors: FleetMemberFormErrors, t: Translate): FleetMemberErrorTexts {
  const texts: FleetMemberErrorTexts = {};
  if (errors.name) {
    texts.name = t('fleet.add_driver_name_required', { defaultValue: 'Escribe el nombre del conductor.' });
  }
  if (errors.phone === 'required') {
    texts.phone = t('fleet.add_driver_phone_required', { defaultValue: 'Escribe el teléfono del conductor.' });
  }
  if (errors.phone === 'invalid') {
    texts.phone = t('fleet.add_driver_phone_invalid', {
      defaultValue: 'Escribe un móvil cubano: 8 dígitos que empiezan por 5 o 6.',
    });
  }
  return texts;
}

/**
 * Which message a failed fleetService.addMember gets. The service's own text
 * is Spanish or a technical line, so the screen shows its translated ones.
 */
export function addDriverFailure(err: unknown): 'exists' | 'failed' {
  return (err as { code?: unknown } | null)?.code === 'FLEET_MEMBER_EXISTS' ? 'exists' : 'failed';
}

/** What the owner typed as a driver to add, or what to fix first. */
export function parseFleetMemberForm(form: FleetMemberFormValues): ParsedFleetMemberForm {
  const name = form.name.trim();
  const phone = form.phone.trim();

  const errors: FleetMemberFormErrors = {};
  if (!name) errors.name = 'required';
  if (!phone) errors.phone = 'required';
  else if (!isValidCubanPhone(phone)) errors.phone = 'invalid';
  if (errors.name || errors.phone) return { ok: false, errors };

  return {
    ok: true,
    member: {
      driver_name: name,
      driver_phone: phone,
      driver_email: form.email.trim() || undefined,
      driver_license_number: form.license.trim() || undefined,
      driver_id_number: form.idNumber.trim() || undefined,
    },
  };
}
