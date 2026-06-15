import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client (rpc only — these services are thin RPC wrappers).
const mockRpc = vi.fn();
const mockSupabase = { rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after the mock is set up.
import { blockService } from '../block.service';
import { reviewService } from '../review.service';

const BLOCKED = '22222222-2222-2222-2222-222222222222';
const REVIEW = '33333333-3333-3333-3333-333333333333';

describe('blockService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('blockUser', () => {
    it('calls block_user with mapped params', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      await blockService.blockUser(BLOCKED, 'conducta agresiva');
      expect(mockRpc).toHaveBeenCalledWith('block_user', {
        p_blocked_id: BLOCKED,
        p_reason: 'conducta agresiva',
      });
    });

    it('passes null reason when omitted', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      await blockService.blockUser(BLOCKED);
      expect(mockRpc).toHaveBeenCalledWith('block_user', expect.objectContaining({ p_reason: null }));
    });

    it('propagates the RPC error', async () => {
      const err = { message: 'Cannot block this user', code: 'P0001' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });
      await expect(blockService.blockUser(BLOCKED)).rejects.toEqual(err);
    });
  });

  describe('unblockUser', () => {
    it('calls unblock_user with the target id', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      await blockService.unblockUser(BLOCKED);
      expect(mockRpc).toHaveBeenCalledWith('unblock_user', { p_blocked_id: BLOCKED });
    });

    it('propagates the RPC error', async () => {
      const err = { message: 'boom', code: 'X' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });
      await expect(blockService.unblockUser(BLOCKED)).rejects.toEqual(err);
    });
  });

  describe('getBlockedUsers', () => {
    it('returns the rows from the RPC', async () => {
      const rows = [{ blocked_id: BLOCKED, full_name: 'X', avatar_url: null, reason: null, created_at: 't' }];
      mockRpc.mockResolvedValueOnce({ data: rows, error: null });
      const result = await blockService.getBlockedUsers();
      expect(mockRpc).toHaveBeenCalledWith('get_blocked_users');
      expect(result).toEqual(rows);
    });

    it('returns [] when the RPC errors (migration not applied — tolerant)', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'function not found', code: 'PGRST202' } });
      expect(await blockService.getBlockedUsers()).toEqual([]);
    });

    it('returns [] when the RPC throws', async () => {
      mockRpc.mockRejectedValueOnce(new Error('network'));
      expect(await blockService.getBlockedUsers()).toEqual([]);
    });

    it('returns [] when data is null', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      expect(await blockService.getBlockedUsers()).toEqual([]);
    });
  });
});

describe('reviewService.reportReview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls report_review with mapped params', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    await reviewService.reportReview(REVIEW, 'insultos en el comentario');
    expect(mockRpc).toHaveBeenCalledWith('report_review', {
      p_review_id: REVIEW,
      p_reason: 'insultos en el comentario',
    });
  });

  it('propagates the RPC error (caller is not the reviewee)', async () => {
    const err = { message: 'You can only report reviews left about you', code: 'P0001' };
    mockRpc.mockResolvedValueOnce({ data: null, error: err });
    await expect(reviewService.reportReview(REVIEW, 'x')).rejects.toEqual(err);
  });
});
