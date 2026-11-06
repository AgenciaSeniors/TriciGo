// ============================================================
// TriciGo Driver — the form that adds a driver to a fleet
// Plain TypeScript, so the driver's vitest setup can test it. The
// duplicate check is not here: it needs the fleet's rows, so
// fleetService.addMember does it.
// ============================================================

import type { FleetMemberInput } from '@tricigo/types';
import { isValidCubanPhone } from '@tricigo/utils';

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
