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
// ============================================================

import { corporateService, fleetService } from '@tricigo/api';

type AccountRequest = Parameters<typeof corporateService.registerAccount>[0];
type FleetRequest = Omit<Parameters<typeof fleetService.submitFleetRequest>[0], 'corporate_account_id'>;

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
