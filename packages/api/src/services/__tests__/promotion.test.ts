import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

import { promotionService } from '../promotion.service';

function mockCountChain(result: { count: number | null; error: unknown }) {
  const eq = vi.fn().mockResolvedValue(result);
  const select = vi.fn(() => ({ eq }));
  mockFrom.mockReturnValueOnce({ select });
  return { select, eq };
}

describe('promotionService.countPendingApproval', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('counts the promotions waiting for an admin', async () => {
    const { select, eq } = mockCountChain({ count: 3, error: null });

    await expect(promotionService.countPendingApproval()).resolves.toBe(3);

    expect(mockFrom).toHaveBeenCalledWith('promotions');
    expect(select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    expect(eq).toHaveBeenCalledWith('pending_approval', true);
  });

  it('is 0 when the column does not exist yet (00641 not applied)', async () => {
    mockCountChain({ count: null, error: { message: 'column promotions.pending_approval does not exist' } });
    await expect(promotionService.countPendingApproval()).resolves.toBe(0);
  });

  it('is 0 when the query throws', async () => {
    mockFrom.mockImplementationOnce(() => {
      throw new Error('network');
    });
    await expect(promotionService.countPendingApproval()).resolves.toBe(0);
  });
});
