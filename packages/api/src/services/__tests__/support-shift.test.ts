import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ rpc: mockRpc }),
}));

import { supportShiftService } from '../support-shift.service';
import { RIDE_ASSIST_UNAVAILABLE } from '../ride-assist.service';

const MISSING = { code: 'PGRST202', message: 'Could not find the function public.ops_set_support_shift' };

describe('supportShiftService', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  describe('setShift', () => {
    it('sends the switch and the number, and returns the counts the server reports', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { success: true, on_shift: true, whatsapp_phone: '+5355123456', handed_over: 0, kept: 0, picked_up: 2 },
        error: null,
      });
      await expect(supportShiftService.setShift(true, '+5355123456')).resolves.toEqual({ handed_over: 0, kept: 0, picked_up: 2 });
      expect(mockRpc).toHaveBeenCalledWith('ops_set_support_shift', { p_on: true, p_whatsapp: '+5355123456' });
    });

    it('sends a null number when none is given', async () => {
      mockRpc.mockResolvedValueOnce({ data: { success: true, handed_over: 1, kept: 1, picked_up: 0 }, error: null });
      await expect(supportShiftService.setShift(false)).resolves.toEqual({ handed_over: 1, kept: 1, picked_up: 0 });
      expect(mockRpc).toHaveBeenCalledWith('ops_set_support_shift', { p_on: false, p_whatsapp: null });
    });

    it.each(['invalid_whatsapp', 'whatsapp_required', 'forbidden', 'invalid_request'])(
      'throws an AppError with the server code %s',
      async (code) => {
        mockRpc.mockResolvedValueOnce({ data: { error: code }, error: null });
        await expect(supportShiftService.setShift(true, 'x')).rejects.toMatchObject({ code });
      },
    );

    it('throws RIDE_ASSIST_UNAVAILABLE when the migration is missing', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: MISSING });
      await expect(supportShiftService.setShift(true, '+5355123456')).rejects.toMatchObject({ code: RIDE_ASSIST_UNAVAILABLE });
    });
  });

  describe('getStatus', () => {
    it('returns what the server sends', async () => {
      const status = {
        me: { on_shift: true, whatsapp_phone: '+5355123456', shift_started_at: '2026-11-09T10:00:00Z', missed_in_a_row: 0 },
        on_shift: [{ user_id: 'u-2', name: 'Melanye' }],
        suggested_whatsapp: '+5355000000',
      };
      mockRpc.mockResolvedValueOnce({ data: status, error: null });
      await expect(supportShiftService.getStatus()).resolves.toEqual(status);
      expect(mockRpc).toHaveBeenCalledWith('ops_support_shift_status');
    });

    it('throws the refusal code', async () => {
      mockRpc.mockResolvedValueOnce({ data: { error: 'forbidden' }, error: null });
      await expect(supportShiftService.getStatus()).rejects.toMatchObject({ code: 'forbidden' });
    });
  });
});
