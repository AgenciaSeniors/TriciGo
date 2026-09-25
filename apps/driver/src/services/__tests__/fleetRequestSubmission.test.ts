import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({
  registerAccount: vi.fn(),
  submitFleetRequest: vi.fn(),
  getSupabaseClient: vi.fn(),
}));

// Mocked with a factory so the real Supabase client is never loaded.
vi.mock('@tricigo/api', () => ({
  corporateService: { registerAccount: api.registerAccount },
  fleetService: { submitFleetRequest: api.submitFleetRequest },
  getSupabaseClient: api.getSupabaseClient,
}));

import { createFleetRequestSubmission } from '../fleetRequestSubmission';

const OWNER = '00000000-0000-4000-8000-000000000011';
const ACCOUNT_1 = '00000000-0000-4000-8000-0000000000a1';
const ACCOUNT_2 = '00000000-0000-4000-8000-0000000000a2';

const accountRequest = { name: 'TaxiHabana', contact_phone: '+5351234567', created_by: OWNER };
const fleetRequest = {
  name: 'TaxiHabana',
  vehicle_types: ['triciclo_basico'],
  members: [{ driver_name: 'Yoel Pérez', driver_phone: '+5351234567' }],
};

beforeEach(() => {
  vi.resetAllMocks();
  api.registerAccount.mockResolvedValue({ id: ACCOUNT_1 });
  api.submitFleetRequest.mockResolvedValue({ fleet_id: 'fleet-1' });
});

describe('createFleetRequestSubmission', () => {
  it('creates the corporate account, then the fleet on it', async () => {
    await createFleetRequestSubmission().submit(accountRequest, fleetRequest);

    expect(api.registerAccount).toHaveBeenCalledTimes(1);
    expect(api.registerAccount).toHaveBeenCalledWith(accountRequest);
    expect(api.submitFleetRequest).toHaveBeenCalledWith({ ...fleetRequest, corporate_account_id: ACCOUNT_1 });
  });

  it('retries on the account it already created instead of creating another', async () => {
    api.submitFleetRequest.mockRejectedValueOnce(new Error('Fleet member insertion failed: connection failure'));
    const submission = createFleetRequestSubmission();

    await expect(submission.submit(accountRequest, fleetRequest)).rejects.toThrow('connection failure');
    await submission.submit(accountRequest, fleetRequest);

    expect(api.registerAccount).toHaveBeenCalledTimes(1);
    expect(api.submitFleetRequest).toHaveBeenCalledTimes(2);
    expect(api.submitFleetRequest).toHaveBeenLastCalledWith({ ...fleetRequest, corporate_account_id: ACCOUNT_1 });
  });

  it('creates the account again when the first attempt to create it failed', async () => {
    api.registerAccount
      .mockRejectedValueOnce(new Error('connection failure'))
      .mockResolvedValueOnce({ id: ACCOUNT_2 });
    const submission = createFleetRequestSubmission();

    await expect(submission.submit(accountRequest, fleetRequest)).rejects.toThrow('connection failure');
    await submission.submit(accountRequest, fleetRequest);

    expect(api.registerAccount).toHaveBeenCalledTimes(2);
    expect(api.submitFleetRequest).toHaveBeenCalledTimes(1);
    expect(api.submitFleetRequest).toHaveBeenCalledWith({ ...fleetRequest, corporate_account_id: ACCOUNT_2 });
  });

  it('does not try to flag the account as a fleet owner, which only an admin can do', async () => {
    await createFleetRequestSubmission().submit(accountRequest, fleetRequest);

    expect(api.getSupabaseClient).not.toHaveBeenCalled();
  });
});
