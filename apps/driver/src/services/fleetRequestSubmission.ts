// ============================================================
// TriciGo Driver — one fleet request form session
// corporate_accounts has no uniqueness on created_by, so creating the
// account on every attempt left one more behind each time a later step
// failed and the owner retried. The account is created once and every
// retry reuses it; fleetService.submitFleetRequest upserts the fleet on
// it. A new form (the screen mounted again) starts a new session.
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
      if (!accountId) {
        accountId = (await corporateService.registerAccount(account)).id;
      }
      await fleetService.submitFleetRequest({ ...fleet, corporate_account_id: accountId });
    },
  };
}
