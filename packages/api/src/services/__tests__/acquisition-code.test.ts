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

function mockUpdateChain(result: { data?: unknown; error: unknown }) {
  const select = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error });
  const eq = vi.fn(() => ({ select }));
  const update = vi.fn(() => ({ eq }));
  mockFrom.mockReturnValueOnce({ update });
  return { update, eq, select };
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

    it('sends no promotion_id when none is chosen, so it works before 00665', async () => {
      const { insert } = mockInsertChain({ data: { code: 'MOTORENKO' }, error: null });

      await acquisitionCodeService.create({
        code: 'MOTORENKO', label: 'Motorenko', channel: 'influencer', audience: 'ambos',
      });

      // The mock takes no parameters, so its calls are typed as empty tuples.
      const [payload] = insert.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(payload).not.toHaveProperty('promotion_id');
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

    it('links the promotion chosen in the form', async () => {
      const { insert } = mockInsertChain({ data: { code: 'MOTORENKO' }, error: null });

      await acquisitionCodeService.create({
        code: 'MOTORENKO', label: 'Motorenko', channel: 'influencer', audience: 'ambos', promotionId: 'p-1',
      });

      expect(insert).toHaveBeenCalledWith(expect.objectContaining({ promotion_id: 'p-1' }));
    });

    it('explains a promotion deleted while the form was open', async () => {
      mockInsertChain({ data: null, error: { code: '23503', message: 'violates foreign key constraint' } });

      await expect(
        acquisitionCodeService.create({ code: 'MOTORENKO', label: 'x', channel: 'otro', audience: 'ambos', promotionId: 'gone' }),
      ).rejects.toThrow('La promoción ya no existe');
    });
  });

  describe('setPromotion', () => {
    it('links a promotion to the code', async () => {
      const { update, eq } = mockUpdateChain({ data: [{ code: 'MOTORENKO' }], error: null });

      await acquisitionCodeService.setPromotion('MOTORENKO', 'p-1');

      expect(mockFrom).toHaveBeenCalledWith('acquisition_codes');
      expect(update).toHaveBeenCalledWith({ promotion_id: 'p-1' });
      expect(eq).toHaveBeenCalledWith('code', 'MOTORENKO');
    });

    it('unlinks it with null', async () => {
      const { update } = mockUpdateChain({ data: [{ code: 'MOTORENKO' }], error: null });

      await acquisitionCodeService.setPromotion('MOTORENKO', null);

      expect(update).toHaveBeenCalledWith({ promotion_id: null });
    });

    it('explains a promotion that no longer exists', async () => {
      mockUpdateChain({ error: { code: '23503', message: 'violates foreign key constraint' } });

      await expect(acquisitionCodeService.setPromotion('MOTORENKO', 'gone')).rejects.toThrow('La promoción ya no existe');
    });

    it('throws when RLS filtered the row out and no row changed', async () => {
      mockUpdateChain({ data: [], error: null });

      await expect(acquisitionCodeService.setPromotion('MOTORENKO', 'p-1')).rejects.toThrow('No se pudo cambiar la promoción');
    });

    it('rethrows any other database error as it came', async () => {
      mockUpdateChain({ error: { code: '42501', message: 'permission denied' } });

      await expect(acquisitionCodeService.setPromotion('MOTORENKO', 'p-1')).rejects.toMatchObject({ code: '42501' });
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

    it('reads the linked promotion and its completed rides', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [{
          code: 'MOTORENKO', label: 'Motorenko', channel: 'influencer', audience: 'ambos', is_active: true,
          created_at: '2026-10-06', signups: '2', rider_signups: '2', driver_signups: '0',
          drivers_approved: '0', riders_with_ride: '1', drivers_with_ride: '0',
          promotion_id: 'p-1', promotion_code: 'MOTO20', promo_rides: '1',
        }],
        error: null,
      });

      const [row] = await acquisitionCodeService.getStats();

      expect(row).toMatchObject({ promotion_id: 'p-1', promotion_code: 'MOTO20', promo_rides: 1 });
    });

    it('works before migration 00665, without the promotion columns', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [{
          code: 'MOTORENKO', label: 'Motorenko', channel: 'influencer', audience: 'ambos', is_active: true,
          created_at: '2026-10-06', signups: '2', rider_signups: '2', driver_signups: '0',
          drivers_approved: '0', riders_with_ride: '1', drivers_with_ride: '0',
        }],
        error: null,
      });

      const [row] = await acquisitionCodeService.getStats();

      expect(row).toMatchObject({ promotion_id: null, promotion_code: null, promo_rides: 0 });
    });

    it('throws when the caller is not an admin', async () => {
      const err = { code: '42501', message: 'Admin only' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });

      await expect(acquisitionCodeService.getStats()).rejects.toEqual(err);
    });
  });
});
