// ============================================================
// TriciGo — Wallet Service Integration Tests
// Tests critical wallet flows through the service layer
// with mocked Supabase client.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Supabase Mock ───────────────────────────────────────────
const mockSingle = vi.fn();
const mockRpc = vi.fn();

function chainable() {
  const obj: Record<string, unknown> = {};
  obj.select = vi.fn().mockReturnValue(obj);
  obj.insert = vi.fn().mockReturnValue(obj);
  obj.update = vi.fn().mockReturnValue(obj);
  obj.eq = vi.fn().mockReturnValue(obj);
  obj.order = vi.fn().mockReturnValue(obj);
  obj.range = vi.fn().mockReturnValue(obj);
  obj.single = mockSingle;
  return obj;
}

const mockFrom = vi.fn().mockImplementation(() => chainable());

vi.mock('../client', () => ({
  getSupabaseClient: () => ({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'test-user-id' } } }) },
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

vi.mock('@tricigo/utils', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import after mocks
import { walletService } from '../services/wallet.service';

describe('Wallet Service Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── P2P Transfer ─────────────────────────────────────────

  describe('transferP2P', () => {
    it('should prevent self-transfer via schema validation', async () => {
      // The transferP2PSchema has a refine: fromUserId !== toUserId
      const sameUserId = '550e8400-e29b-41d4-a716-446655440000';

      await expect(
        walletService.transferP2P(sameUserId, sameUserId, 100),
      ).rejects.toThrow();
    });

    it('should succeed for valid transfer between different users', async () => {
      const fromUser = '550e8400-e29b-41d4-a716-446655440001';
      const toUser = '550e8400-e29b-41d4-a716-446655440002';

      mockRpc.mockResolvedValueOnce({ data: 'txn-001', error: null });

      const result = await walletService.transferP2P(fromUser, toUser, 500);
      expect(result).toBe('txn-001');
      expect(mockRpc).toHaveBeenCalledWith('transfer_wallet_p2p', {
        p_from_user_id: fromUser,
        p_to_user_id: toUser,
        p_amount: 500,
        p_note: null,
      });
    });

    it('should pass note to the RPC when provided', async () => {
      const fromUser = '550e8400-e29b-41d4-a716-446655440001';
      const toUser = '550e8400-e29b-41d4-a716-446655440002';

      mockRpc.mockResolvedValueOnce({ data: 'txn-002', error: null });

      await walletService.transferP2P(fromUser, toUser, 100, 'Gracias!');
      expect(mockRpc).toHaveBeenCalledWith('transfer_wallet_p2p', {
        p_from_user_id: fromUser,
        p_to_user_id: toUser,
        p_amount: 100,
        p_note: 'Gracias!',
      });
    });

    it('should reject transfer with zero amount', async () => {
      const fromUser = '550e8400-e29b-41d4-a716-446655440001';
      const toUser = '550e8400-e29b-41d4-a716-446655440002';

      await expect(
        walletService.transferP2P(fromUser, toUser, 0),
      ).rejects.toThrow();
    });

    it('should reject transfer exceeding max amount', async () => {
      const fromUser = '550e8400-e29b-41d4-a716-446655440001';
      const toUser = '550e8400-e29b-41d4-a716-446655440002';

      await expect(
        walletService.transferP2P(fromUser, toUser, 200000),
      ).rejects.toThrow();
    });
  });

  // ─── Recharge ─────────────────────────────────────────────

  describe('requestRecharge', () => {
    it('should validate recharge amount lower bound', async () => {
      // min amount is 100 CUP per rechargeSchema
      await expect(
        walletService.requestRecharge('550e8400-e29b-41d4-a716-446655440001', 10),
      ).rejects.toThrow();
    });

    it('should validate recharge amount upper bound', async () => {
      // max amount is 50000 CUP per rechargeSchema
      await expect(
        walletService.requestRecharge('550e8400-e29b-41d4-a716-446655440001', 60000),
      ).rejects.toThrow();
    });

    it('should accept valid recharge amount within bounds', async () => {
      const mockRecharge = {
        id: 'rch-001',
        user_id: '550e8400-e29b-41d4-a716-446655440001',
        amount: 5000,
        status: 'pending',
      };

      mockSingle.mockResolvedValueOnce({ data: mockRecharge, error: null });

      const result = await walletService.requestRecharge(
        '550e8400-e29b-41d4-a716-446655440001',
        5000,
      );
      expect(result).toBeDefined();
      expect(result.amount).toBe(5000);
    });
  });

  // ─── getBalance ───────────────────────────────────────────

  describe('getBalance', () => {
    it('should return zero balances when no account exists', async () => {
      // PGRST116 = "no rows returned" from Supabase single()
      mockSingle.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST116', message: 'No rows' },
      });

      const result = await walletService.getBalance('nonexistent-user');
      expect(result).toEqual({ available: 0, held: 0 });
    });

    it('should return balances from existing account', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { balance: 15000, held_balance: 500 },
        error: null,
      });

      const result = await walletService.getBalance('550e8400-e29b-41d4-a716-446655440001');
      expect(result.available).toBe(15000);
      expect(result.held).toBe(500);
    });
  });

  // ─── getSummary ───────────────────────────────────────────

  describe('getSummary', () => {
    it('should return default summary when RPC returns null', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      const result = await walletService.getSummary('test-user');
      expect(result.available_balance).toBe(0);
      expect(result.held_balance).toBe(0);
      expect(result.currency).toBe('TRC');
    });
  });
});
