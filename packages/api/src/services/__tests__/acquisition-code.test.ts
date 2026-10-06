import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom, rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

import { acquisitionCodeService } from '../acquisition-code.service';

function mockInsertChain(result: { data: unknown; error: unknown }) {
  const single = vi.fn().mockResolvedValue(result);
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  mockFrom.mockReturnValueOnce({ insert });
  return { insert };
}

describe('acquisitionCodeService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('create', () => {
    it('stores the code upper-case and trimmed', async () => {
      const row = { code: 'MOTORENKO', label: 'Motorenko', channel: 'influencer', audience: 'choferes' };
      const { insert } = mockInsertChain({ data: row, error: null });

      const result = await acquisitionCodeService.create({
        code: ' motorenko ',
        label: ' Motorenko ',
        channel: 'influencer',
        audience: 'choferes',
      });

      expect(mockFrom).toHaveBeenCalledWith('acquisition_codes');
      expect(insert).toHaveBeenCalledWith({
        code: 'MOTORENKO',
        label: 'Motorenko',
        channel: 'influencer',
        audience: 'choferes',
        notes: null,
      });
      expect(result).toEqual(row);
    });

    it('rejects a code with characters the database does not accept, without calling it', async () => {
      await expect(
        acquisitionCodeService.create({ code: 'mo torenko!', label: 'x', channel: 'otro', audience: 'ambos' }),
      ).rejects.toThrow('letras, números y guiones');
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('explains a duplicate or a clash with a referral code', async () => {
      mockInsertChain({ data: null, error: { code: '23505', message: 'duplicate key' } });

      await expect(
        acquisitionCodeService.create({ code: 'CAFE1234', label: 'x', channel: 'otro', audience: 'ambos' }),
      ).rejects.toThrow('CAFE1234 ya existe');
    });
  });

  describe('getStats', () => {
    it('turns the bigint counts PostgREST returns into numbers', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [{
          code: 'MOTORENKO', label: 'Motorenko', channel: 'influencer', audience: 'choferes', is_active: true,
          created_at: '2026-10-06', signups: '2', rider_signups: '1', driver_signups: '1',
          drivers_approved: '1', riders_with_ride: '1', drivers_with_ride: '0',
        }],
        error: null,
      });

      const [row] = await acquisitionCodeService.getStats();

      expect(mockRpc).toHaveBeenCalledWith('admin_signup_code_stats');
      expect(row).toMatchObject({ signups: 2, rider_signups: 1, driver_signups: 1, drivers_approved: 1, riders_with_ride: 1, drivers_with_ride: 0 });
    });

    it('throws when the caller is not an admin', async () => {
      const err = { code: '42501', message: 'Admin only' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });

      await expect(acquisitionCodeService.getStats()).rejects.toEqual(err);
    });
  });
});
