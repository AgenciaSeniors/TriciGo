import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockSingle = vi.fn();
const mockMaybeSingle = vi.fn();
const mockRange = vi.fn(() => ({ data: [], error: null }));
const mockOrder = vi.fn(() => ({ range: mockRange, data: [], error: null }));
const mockEq = vi.fn(() => ({ order: mockOrder, single: mockSingle, maybeSingle: mockMaybeSingle, eq: mockEq, limit: vi.fn(() => ({ data: [], error: null })) }));
const mockOr = vi.fn(() => ({ order: mockOrder }));
const mockSelect = vi.fn(() => ({ eq: mockEq, or: mockOr, single: mockSingle, order: mockOrder }));
const mockInsert = vi.fn(() => ({ select: vi.fn(() => ({ single: mockSingle })) }));
const mockRpc = vi.fn();
const mockFrom = vi.fn(() => ({ select: mockSelect, insert: mockInsert }));
const mockSupabase = { from: mockFrom, rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { walletService } from '../wallet.service';

describe('walletService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getConfigValue', () => {
    it('returns parsed string value for existing key', async () => {
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { value: '0.15' },
              error: null,
            }),
          }),
        }),
        insert: mockInsert,
      });

      const value = await walletService.getConfigValue('commission_rate');
      expect(value).toBe('0.15');
      expect(mockFrom).toHaveBeenCalledWith('platform_config');
    });

    it('returns null for missing key', async () => {
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: null,
              error: null,
            }),
          }),
        }),
        insert: mockInsert,
      });

      const value = await walletService.getConfigValue('nonexistent_key');
      expect(value).toBeNull();
    });

    it('handles numeric JSONB value by converting to string', async () => {
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { value: 0.15 },
              error: null,
            }),
          }),
        }),
        insert: mockInsert,
      });

      const value = await walletService.getConfigValue('commission_rate');
      expect(value).toBe('0.15');
    });

    it('throws on Supabase error', async () => {
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'DB error', code: '42P01' },
            }),
          }),
        }),
        insert: mockInsert,
      });

      await expect(walletService.getConfigValue('commission_rate')).rejects.toEqual({
        message: 'DB error',
        code: '42P01',
      });
    });
  });

  describe('getTransactions', () => {
    it('select includes ledger_entries amount', async () => {
      const mockTxRange = vi.fn().mockResolvedValue({
        data: [
          {
            id: 'tx-1',
            description: 'Pago de viaje',
            ledger_entries: [{ account_id: 'acc-1', amount: -5000 }],
          },
        ],
        error: null,
      });
      const mockTxOrder = vi.fn().mockReturnValue({ range: mockTxRange });
      const mockTxEqInner = vi.fn().mockReturnValue({ order: mockTxOrder });
      const mockTxSelect = vi.fn().mockReturnValue({ eq: mockTxEqInner });

      mockFrom.mockReturnValueOnce({ select: mockTxSelect, insert: mockInsert });

      const txns = await walletService.getTransactions('acc-1');

      // Verify select string includes ledger_entries amount
      const selectArg = mockTxSelect.mock.calls[0]?.[0] as string;
      expect(selectArg).toContain('ledger_entries!inner');
      expect(selectArg).toContain('amount');
      expect(selectArg).toContain('account_id');

      expect(txns).toHaveLength(1);
      expect((txns[0] as any).ledger_entries[0].amount).toBe(-5000);
    });

    it('respects pagination parameters', async () => {
      const mockTxRange = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockTxOrder = vi.fn().mockReturnValue({ range: mockTxRange });
      const mockTxEqInner = vi.fn().mockReturnValue({ order: mockTxOrder });
      const mockTxSelect = vi.fn().mockReturnValue({ eq: mockTxEqInner });

      mockFrom.mockReturnValueOnce({ select: mockTxSelect, insert: mockInsert });

      await walletService.getTransactions('acc-1', 2, 10);

      // page=2, pageSize=10 → from=20, to=29
      expect(mockTxRange).toHaveBeenCalledWith(20, 29);
    });
  });

  describe('getAccount', () => {
    it('returns account for user', async () => {
      const mockAccount = {
        id: 'wa-1',
        user_id: 'user-1',
        account_type: 'customer_cash',
        balance: 50000,
        held_balance: 0,
        currency: 'TRC',
      };

      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: mockAccount,
                error: null,
              }),
            }),
          }),
        }),
        insert: mockInsert,
      });

      const account = await walletService.getAccount('user-1');
      expect(account).toEqual(mockAccount);
      expect(mockFrom).toHaveBeenCalledWith('wallet_accounts');
    });

    it('returns null when no account exists', async () => {
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: null,
                error: { code: 'PGRST116', message: 'No rows' },
              }),
            }),
          }),
        }),
        insert: mockInsert,
      });

      const account = await walletService.getAccount('unknown-user');
      expect(account).toBeNull();
    });
  });

  describe('getSummary', () => {
    it('returns wallet summary from RPC', async () => {
      const mockSummary = {
        available_balance: 45000,
        held_balance: 5000,
        total_earned: 100000,
        total_spent: 50000,
        currency: 'TRC',
      };

      mockRpc.mockResolvedValueOnce({ data: [mockSummary], error: null });

      const summary = await walletService.getSummary('user-1');
      expect(summary.available_balance).toBe(45000);
      expect(summary.held_balance).toBe(5000);
      expect(mockRpc).toHaveBeenCalledWith('get_wallet_summary', { p_user_id: 'user-1' });
    });

    it('returns defaults when RPC returns null', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      const summary = await walletService.getSummary('user-1');
      expect(summary.available_balance).toBe(0);
      expect(summary.currency).toBe('TRC');
    });
  });
});
