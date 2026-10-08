import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

import { promotionService } from '../promotion.service';
import { AppError } from '../../errors';

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

/** from('promotions').update(...).eq(...).eq(...).eq(...).select('id') → result */
function mockApproveChain(result: { data: unknown; error: unknown }) {
  const select = vi.fn().mockResolvedValue(result);
  const eq = vi.fn();
  const chain = { eq, select };
  eq.mockReturnValue(chain);
  const update = vi.fn(() => chain);
  mockFrom.mockReturnValueOnce({ update });
  return { update, eq, select };
}

/** from('promotions').update(...).eq('id', id) → result (setActive) */
function mockSetActiveChain(result: { error: unknown }) {
  const eq = vi.fn().mockResolvedValue(result);
  const update = vi.fn(() => ({ eq }));
  mockFrom.mockReturnValueOnce({ update });
  return { update, eq };
}

describe('promotionService.approve', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('turns on the revision the admin saw, only while it is still off', async () => {
    const { update, eq, select } = mockApproveChain({ data: [{ id: 'p1' }], error: null });

    await expect(promotionService.approve('p1', 4)).resolves.toBeUndefined();

    expect(mockFrom).toHaveBeenCalledWith('promotions');
    expect(update).toHaveBeenCalledWith({ is_active: true });
    expect(eq).toHaveBeenCalledWith('id', 'p1');
    expect(eq).toHaveBeenCalledWith('revision', 4);
    expect(eq).toHaveBeenCalledWith('is_active', false);
    expect(select).toHaveBeenCalledWith('id');
  });

  it('throws PROMOTION_CHANGED (409) when no row matched', async () => {
    mockApproveChain({ data: [], error: null });

    const err = await promotionService.approve('p1', 4).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'PROMOTION_CHANGED', statusCode: 409 });
    // Only the guarded update ran: nothing fell back to an unconditional activation.
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('throws PROMOTION_CHANGED when PostgREST returns no data at all', async () => {
    mockApproveChain({ data: null, error: null });
    await expect(promotionService.approve('p1', 0)).rejects.toMatchObject({ code: 'PROMOTION_CHANGED' });
  });

  it('falls back to a plain activation while the revision column does not exist (00641 not applied)', async () => {
    mockApproveChain({
      data: null,
      error: { code: '42703', message: 'column promotions.revision does not exist' },
    });
    const fallback = mockSetActiveChain({ error: null });

    await expect(promotionService.approve('p1', 0)).resolves.toBeUndefined();

    expect(fallback.update).toHaveBeenCalledWith({ is_active: true });
    expect(fallback.eq).toHaveBeenCalledWith('id', 'p1');
  });

  it('rethrows any other error', async () => {
    const boom = { code: '42501', message: 'permission denied for table promotions' };
    mockApproveChain({ data: null, error: boom });

    await expect(promotionService.approve('p1', 0)).rejects.toBe(boom);
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
});
