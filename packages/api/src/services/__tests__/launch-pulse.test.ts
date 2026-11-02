import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom, rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

import { launchPulseService, driverOutreachService } from '../launch-pulse.service';

describe('launchPulseService.getPulse', () => {
  beforeEach(() => vi.resetAllMocks());

  it('asks for 12 weeks by default and returns the payload', async () => {
    const pulse = { generated_at: 'x', timezone: 'America/Havana', online_since: null, now: {}, weeks: [] };
    mockRpc.mockResolvedValueOnce({ data: pulse, error: null });

    await expect(launchPulseService.getPulse()).resolves.toBe(pulse);
    expect(mockRpc).toHaveBeenCalledWith('admin_launch_pulse', { p_weeks: 12 });
  });

  it('passes the number of weeks', async () => {
    mockRpc.mockResolvedValueOnce({ data: { weeks: [] }, error: null });
    await launchPulseService.getPulse(4);
    expect(mockRpc).toHaveBeenCalledWith('admin_launch_pulse', { p_weeks: 4 });
  });

  it('throws when the caller is not an admin', async () => {
    const err = { code: '42501', message: 'Admin only' };
    mockRpc.mockResolvedValueOnce({ data: null, error: err });
    await expect(launchPulseService.getPulse()).rejects.toEqual(err);
  });
});

describe('driverOutreachService.getIncompleteSignups', () => {
  beforeEach(() => vi.resetAllMocks());

  it('turns counts into numbers and never returns null arrays', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{
        driver_profile_id: 'dp1', user_id: 'u1', full_name: 'Pepe', phone: '+5355500001',
        signed_up_at: '2026-10-01', last_sign_in_at: null, docs_uploaded: '2',
        missing_docs: null, rejected_docs: null, has_push: false, contact_count: '1',
        last_contact_at: null, last_contact_by: null, last_contact_channel: null, last_contact_note: null,
      }],
      error: null,
    });

    const [row] = await driverOutreachService.getIncompleteSignups();

    expect(mockRpc).toHaveBeenCalledWith('admin_incomplete_driver_signups');
    expect(row).toMatchObject({ docs_uploaded: 2, contact_count: 1, missing_docs: [], rejected_docs: [] });
  });
});

describe('driverOutreachService.logContact', () => {
  beforeEach(() => vi.resetAllMocks());

  it('logs through ops_log_driver_outreach with the trimmed note, never who or when (00672)', async () => {
    mockRpc.mockResolvedValueOnce({ data: { success: true, id: 'o1' }, error: null });

    await driverOutreachService.logContact('dp1', 'whatsapp', '  Le escribí  ');

    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('ops_log_driver_outreach', {
      p_driver_profile_id: 'dp1', p_channel: 'whatsapp', p_note: 'Le escribí',
    });
  });

  it('sends an empty note as null', async () => {
    mockRpc.mockResolvedValueOnce({ data: { success: true, id: 'o1' }, error: null });
    await driverOutreachService.logContact('dp1', 'llamada', '   ');
    expect(mockRpc.mock.calls[0]![1]).toMatchObject({ p_note: null });
  });

  it("throws the server's refusal with its code", async () => {
    mockRpc.mockResolvedValueOnce({ data: { error: 'forbidden' }, error: null });
    await expect(driverOutreachService.logContact('dp1', 'whatsapp')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('throws the database error', async () => {
    const err = { code: '57014', message: 'canceling statement due to statement timeout' };
    mockRpc.mockResolvedValueOnce({ data: null, error: err });
    await expect(driverOutreachService.logContact('dp1', 'whatsapp')).rejects.toEqual(err);
  });
});
