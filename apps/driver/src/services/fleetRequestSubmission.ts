// ============================================================
// TriciGo Driver — one fleet request form session
// corporate_accounts has no uniqueness on created_by, so creating the
// account on every attempt left one more behind each time a later step
// failed and the owner retried. The account is created once and every
// retry reuses it, first bringing it up to date with the form (the
// owner may have fixed the name or the email), while
// fleetService.submitFleetRequest upserts the fleet and its drivers. A
// new form (the screen mounted again) starts a new session.
//
// The account is not flagged is_fleet_owner here: since 00418/00434
// only an admin can set that flag, so for any other user that update
// was a no-op that returned no error.
//
// buildFleetRequest turns what the form holds into the two requests,
// so every field the owner fills in is covered by a test: the city the
// form requires used to be dropped here without anyone noticing.
// ============================================================

import { corporateService, fleetService } from '@tricigo/api';
import type { FleetMemberInput } from '@tricigo/types';

type AccountRequest = Parameters<typeof corporateService.registerAccount>[0];
type FleetRequest = Omit<Parameters<typeof fleetService.submitFleetRequest>[0], 'corporate_account_id'>;

/** The fleet request form as the owner filled it in. */
export interface FleetRequestFormValues {
  ownerUserId: string;
  ownerPhone: string;
  fleetName: string;
  taxId: string;
  city: string;
  responsibleName: string;
  responsibleEmail: string;
  vehicleTypes: string[];
  vehicleCount: string;
  /** Comma-separated, as typed. */
  zones: string;
  hoursStart: string;
  hoursEnd: string;
  ridesPerDay: string;
  /** The drivers the form counts as valid (name and phone filled in). */
  members: FleetMemberInput[];
}

/** The account and fleet requests submit() takes, trimmed, empty fields left out. */
export function buildFleetRequest(form: FleetRequestFormValues): { account: AccountRequest; fleet: FleetRequest } {
  const name = form.fleetName.trim();
  const responsible = form.responsibleName.trim();
  return {
    account: {
      name,
      contact_phone: form.ownerPhone,
      contact_email: form.responsibleEmail.trim() || undefined,
      tax_id: form.taxId.trim() || undefined,
      created_by: form.ownerUserId,
    },
    fleet: {
      name,
      city: form.city.trim() || undefined,
      vehicle_count_estimate: form.vehicleCount ? parseInt(form.vehicleCount, 10) : undefined,
      vehicle_types: form.vehicleTypes,
      operating_zones: form.zones
        .split(',')
        .map((z) => z.trim())
        .filter(Boolean),
      estimated_rides_per_day_per_vehicle: form.ridesPerDay ? parseInt(form.ridesPerDay, 10) : undefined,
      operating_hours_start: form.hoursStart.trim() || undefined,
      operating_hours_end: form.hoursEnd.trim() || undefined,
      notes: responsible ? `Responsable: ${responsible}` : undefined,
      members: form.members.map((m) => ({
        driver_name: m.driver_name.trim(),
        driver_phone: m.driver_phone.trim(),
        driver_email: m.driver_email?.trim() || undefined,
        driver_license_number: m.driver_license_number?.trim() || undefined,
        driver_id_number: m.driver_id_number?.trim() || undefined,
      })),
    },
  };
}

export function createFleetRequestSubmission() {
  let accountId: string | null = null;

  return {
    async submit(account: AccountRequest, fleet: FleetRequest): Promise<void> {
      if (accountId) {
        // Goes through the corp-admin row registerAccount creates; without
        // it RLS makes this a no-op and the first values stay.
        await corporateService.updateAccount(accountId, {
          name: account.name,
          contact_phone: account.contact_phone,
          contact_email: account.contact_email ?? null,
          tax_id: account.tax_id ?? null,
        });
      } else {
        accountId = (await corporateService.registerAccount(account)).id;
      }
      await fleetService.submitFleetRequest({ ...fleet, corporate_account_id: accountId });
    },
  };
}
