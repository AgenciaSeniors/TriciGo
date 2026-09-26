import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({
  registerAccount: vi.fn(),
  updateAccount: vi.fn(),
  submitFleetRequest: vi.fn(),
}));

// Mocked with a factory so the real Supabase client is never loaded.
vi.mock('@tricigo/api', () => ({
  corporateService: { registerAccount: api.registerAccount, updateAccount: api.updateAccount },
  fleetService: { submitFleetRequest: api.submitFleetRequest },
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
  api.updateAccount.mockResolvedValue(undefined);
  api.submitFleetRequest.mockResolvedValue({ fleet_id: 'fleet-1' });
});

describe('createFleetRequestSubmission', () => {
  it('creates the corporate account, then the fleet on it', async () => {
    await createFleetRequestSubmission().submit(accountRequest, fleetRequest);

    expect(api.registerAccount).toHaveBeenCalledTimes(1);
    expect(api.registerAccount).toHaveBeenCalledWith(accountRequest);
    expect(api.updateAccount).not.toHaveBeenCalled();
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

  it('brings the account up to date with the form before the fleet step of a retry', async () => {
    // The hours are free text and the time column rejects "22h", so the fleet
    // step fails after the account exists; the owner then fixes the form.
    api.submitFleetRequest.mockRejectedValueOnce(new Error('invalid input syntax for type time: "22h"'));
    const submission = createFleetRequestSubmission();
    await expect(submission.submit(accountRequest, fleetRequest)).rejects.toThrow('22h');

    await submission.submit(
      { ...accountRequest, name: 'Taxi Habana', contact_email: 'flota@taxihabana.cu' },
      { ...fleetRequest, name: 'Taxi Habana' },
    );

    expect(api.updateAccount).toHaveBeenCalledTimes(1);
    expect(api.updateAccount).toHaveBeenCalledWith(ACCOUNT_1, {
      name: 'Taxi Habana',
      contact_phone: '+5351234567',
      contact_email: 'flota@taxihabana.cu',
      tax_id: null,
    });
    const updateOrder = api.updateAccount.mock.invocationCallOrder[0] ?? Infinity;
    const retryFleetOrder = api.submitFleetRequest.mock.invocationCallOrder[1] ?? -Infinity;
    expect(updateOrder).toBeLessThan(retryFleetOrder);
  });

  it('creates the account again when the first attempt to create it failed', async () => {
    api.registerAccount
      .mockRejectedValueOnce(new Error('connection failure'))
      .mockResolvedValueOnce({ id: ACCOUNT_2 });
    const submission = createFleetRequestSubmission();

    await expect(submission.submit(accountRequest, fleetRequest)).rejects.toThrow('connection failure');
    await submission.submit(accountRequest, fleetRequest);

    expect(api.registerAccount).toHaveBeenCalledTimes(2);
    expect(api.updateAccount).not.toHaveBeenCalled();
    expect(api.submitFleetRequest).toHaveBeenCalledTimes(1);
    expect(api.submitFleetRequest).toHaveBeenCalledWith({ ...fleetRequest, corporate_account_id: ACCOUNT_2 });
  });
});
