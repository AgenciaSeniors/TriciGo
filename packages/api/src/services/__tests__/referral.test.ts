import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client. The shape is small: we only need `.rpc(...)` and
// `.from(...).select(...).eq(...)...` chains for the service's call sites.
const mockSingle = vi.fn();
const mockLimit = vi.fn(() => ({ single: mockSingle }));
const mockEq = vi.fn(() => ({ limit: mockLimit, single: mockSingle }));
const mockIlike = vi.fn(() => ({ limit: mockLimit }));
const mockSelect = vi.fn(() => ({ eq: mockEq, ilike: mockIlike, order: vi.fn(() => ({ data: [], error: null })) }));
const mockInsert = vi.fn(() => ({ select: vi.fn(() => ({ single: mockSingle })) }));
const mockFrom = vi.fn(() => ({ select: mockSelect, insert: mockInsert }));
const mockRpc = vi.fn();
const mockSupabase = { from: mockFrom, rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { referralService } from '../referral.service';

describe('referralService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getOrCreateReferralCode (RPC path)', () => {
    it('returns RPC code when get_or_create_referral_code RPC succeeds', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'ABCDEF1234', error: null });

      const code = await referralService.getOrCreateReferralCode('user-1');
      expect(code).toBe('ABCDEF1234');
      expect(mockRpc).toHaveBeenCalledWith('get_or_create_referral_code');
    });

    it('throws if RPC returns non-missing error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied' } });

      await expect(referralService.getOrCreateReferralCode('user-1')).rejects.toMatchObject({
        code: '42501',
      });
    });

    it('propagates a runtime "function does not exist" error (42883) instead of returning a fake code', async () => {
      // Regression for the referral bug: gen_random_bytes(5) unresolved inside
      // the RPC body raised 42883. The old regex mis-classified it as a missing
      // RPC and returned an unredeemable placeholder. It must now propagate.
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: '42883', message: 'function gen_random_bytes(integer) does not exist' },
      });

      await expect(
        referralService.getOrCreateReferralCode('a1b2c3d4-ef56-7890-abcd-ef1234567890'),
      ).rejects.toMatchObject({ code: '42883' });
    });
  });

  describe('getOrCreateReferralCode (legacy fallback when migration not applied)', () => {
    it('returns existing referral code from referrals table if RPC missing', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST202', message: 'function get_or_create_referral_code does not exist' },
      });

      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [{ code: 'LEGACYAA' }], error: null }),
          }),
        }),
        insert: mockInsert,
      });

      const code = await referralService.getOrCreateReferralCode('abcd1234-5678-uuid');
      expect(code).toBe('LEGACYAA');
    });

    it('falls back to UUID prefix when RPC missing and no existing referrals', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST202', message: 'function get_or_create_referral_code does not exist' },
      });

      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
        insert: mockInsert,
      });

      const code = await referralService.getOrCreateReferralCode('a1b2c3d4-ef56-7890-abcd-ef1234567890');
      expect(code).toBe('A1B2C3D4');
      expect(code).toHaveLength(8);
    });
  });

  describe('applyReferralCode (RPC path)', () => {
    it('fetches and returns the referral row when apply_referral_code RPC succeeds', async () => {
      const mockReferral = {
        id: 'new-ref-id',
        referrer_id: 'referrer-id',
        referee_id: 'referee-id',
        code: 'ABC12345',
        status: 'pending',
        bonus_amount: 500,
      };

      mockRpc.mockResolvedValueOnce({ data: 'new-ref-id', error: null });

      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: mockReferral, error: null }),
          }),
        }),
        insert: mockInsert,
      });

      const result = await referralService.applyReferralCode('referee-id', 'abc12345');
      expect(result.status).toBe('pending');
      expect(result.referrer_id).toBe('referrer-id');
      expect(mockRpc).toHaveBeenCalledWith('apply_referral_code', { p_code: 'ABC12345' });
    });

    it('maps P0001 → "Código de referido inválido"', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'P0001', message: 'Código de referido inválido' },
      });

      await expect(
        referralService.applyReferralCode('referee-id', 'NOTREAL'),
      ).rejects.toThrow('Código de referido inválido');
    });

    it('maps P0002 → "No puedes usar tu propio código"', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'P0002', message: 'self-referral' },
      });

      await expect(
        referralService.applyReferralCode('referee-id', 'OWN12345'),
      ).rejects.toThrow('No puedes usar tu propio código');
    });

    it('maps P0003 → "Ya usaste un código de referido"', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'P0003', message: 'duplicate referee' },
      });

      await expect(
        referralService.applyReferralCode('referee-id', 'AAAA1111'),
      ).rejects.toThrow('Ya usaste un código de referido');
    });

    it('falls back to legacy path when RPC missing (PGRST202)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST202', message: 'function apply_referral_code does not exist' },
      });

      // Legacy uses ILIKE on users + check existing + insert.
      mockFrom
        // 1) ILIKE on users
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            ilike: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
          insert: mockInsert,
        });

      await expect(
        referralService.applyReferralCode('referee-id', 'NOMATCH1'),
      ).rejects.toThrow('Código de referido inválido');
    });

    it('rethrows non-mapped errors', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: '42501', message: 'permission denied' },
      });

      await expect(
        referralService.applyReferralCode('referee-id', 'SOMECODE'),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('applyInviteCode', () => {
    function mockReferralFetch(referral: Record<string, unknown>) {
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: referral, error: null }),
          }),
        }),
        insert: mockInsert,
      });
    }

    it('records an acquisition code and does not touch referrals', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'applied', error: null });

      const result = await referralService.applyInviteCode('user-1', '  motorenko ');

      expect(result).toEqual({ kind: 'source', code: 'MOTORENKO', alreadySet: false });
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith('apply_signup_code', { p_code: 'MOTORENKO' });
    });

    it('reports an acquisition code that was already set', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'already_set', error: null });

      await expect(referralService.applyInviteCode('user-1', 'BOLSAS-VEDADO')).resolves.toEqual({
        kind: 'source',
        code: 'BOLSAS-VEDADO',
        alreadySet: true,
      });
    });

    it("falls back to a friend's referral code when it is not an acquisition code", async () => {
      const referral = { id: 'ref-1', referrer_id: 'friend', referee_id: 'user-1', code: 'CAFE1234', status: 'pending' };
      mockRpc
        .mockResolvedValueOnce({ data: 'not_found', error: null })
        .mockResolvedValueOnce({ data: 'ref-1', error: null });
      mockReferralFetch(referral);

      const result = await referralService.applyInviteCode('user-1', 'cafe1234');

      expect(mockRpc).toHaveBeenNthCalledWith(1, 'apply_signup_code', { p_code: 'CAFE1234' });
      expect(mockRpc).toHaveBeenNthCalledWith(2, 'apply_referral_code', { p_code: 'CAFE1234' });
      expect(result).toEqual({ kind: 'referral', referral });
    });

    it('keeps the referral error messages when the code is neither', async () => {
      mockRpc
        .mockResolvedValueOnce({ data: 'not_found', error: null })
        .mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'Codigo de referido invalido' } });

      await expect(referralService.applyInviteCode('user-1', 'NOPE')).rejects.toThrow('Código de referido inválido');
    });

    it('treats the code as a referral while apply_signup_code does not exist yet (00619 not applied)', async () => {
      const referral = { id: 'ref-2', referrer_id: 'friend', referee_id: 'user-1', code: 'CAFE1234', status: 'pending' };
      mockRpc
        .mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.apply_signup_code(p_code)' } })
        .mockResolvedValueOnce({ data: 'ref-2', error: null });
      mockReferralFetch(referral);

      await expect(referralService.applyInviteCode('user-1', 'CAFE1234')).resolves.toEqual({ kind: 'referral', referral });
    });

    it('throws any other error from apply_signup_code', async () => {
      const err = { code: '28000', message: 'Authentication required' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });

      await expect(referralService.applyInviteCode('user-1', 'MOTORENKO')).rejects.toEqual(err);
      expect(mockRpc).toHaveBeenCalledTimes(1);
    });
  });

  describe('getReferralHistory', () => {
    it('returns referrals where user is referrer', async () => {
      const mockHistory = [
        { id: 'ref-1', referrer_id: 'user-1', status: 'rewarded', bonus_amount: 500 },
        { id: 'ref-2', referrer_id: 'user-1', status: 'pending', bonus_amount: 500 },
      ];

      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: mockHistory, error: null }),
          }),
        }),
        insert: mockInsert,
      });

      const history = await referralService.getReferralHistory('user-1');
      expect(history).toHaveLength(2);
      expect(history[0]?.status).toBe('rewarded');
    });
  });

  describe('hasBeenReferred', () => {
    it('returns true if user has a referral as referee', async () => {
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [{ id: 'some-ref' }], error: null }),
          }),
        }),
        insert: mockInsert,
      });

      expect(await referralService.hasBeenReferred('user-1')).toBe(true);
    });

    it('returns false if user has no referral', async () => {
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
        insert: mockInsert,
      });

      expect(await referralService.hasBeenReferred('user-1')).toBe(false);
    });
  });
});
