import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockSingle = vi.fn();
const mockLimit = vi.fn(() => ({ single: mockSingle }));
const mockEq = vi.fn(() => ({ limit: mockLimit, single: mockSingle }));
const mockIlike = vi.fn(() => ({ limit: mockLimit }));
const mockSelect = vi.fn(() => ({ eq: mockEq, ilike: mockIlike, order: vi.fn(() => ({ data: [], error: null })) }));
const mockInsert = vi.fn(() => ({ select: vi.fn(() => ({ single: mockSingle })) }));
const mockFrom = vi.fn(() => ({ select: mockSelect, insert: mockInsert }));
const mockSupabase = { from: mockFrom };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { referralService } from '../referral.service';

describe('referralService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getOrCreateReferralCode', () => {
    it('returns existing code if user has referrals', async () => {
      // Mock: user has existing referrals
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{ code: 'ABCD1234' }],
              error: null,
            }),
          }),
        }),
      });

      const code = await referralService.getOrCreateReferralCode('abcd1234-5678-uuid');
      expect(code).toBe('ABCD1234');
    });

    it('generates code from userId prefix if no referrals exist', async () => {
      // Mock: no existing referrals
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [],
              error: null,
            }),
          }),
        }),
      });

      const code = await referralService.getOrCreateReferralCode('a1b2c3d4-ef56-7890-abcd-ef1234567890');
      expect(code).toBe('A1B2C3D4');
      expect(code).toHaveLength(8);
    });
  });

  describe('applyReferralCode', () => {
    it('throws if code matches no user', async () => {
      // Mock: users query returns empty
      mockFrom
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            ilike: vi.fn().mockResolvedValue({
              data: [],
              error: null,
            }),
          }),
        });

      await expect(
        referralService.applyReferralCode('referee-id', 'INVALID1'),
      ).rejects.toThrow('Código de referido inválido');
    });

    it('throws if user tries self-referral', async () => {
      const userId = 'self0000-user-uuid';

      // Mock: users query returns the same user
      mockFrom
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            ilike: vi.fn().mockResolvedValue({
              data: [{ id: userId }],
              error: null,
            }),
          }),
        });

      await expect(
        referralService.applyReferralCode(userId, 'SELF0000'),
      ).rejects.toThrow('No puedes usar tu propio código');
    });

    it('throws if user already has a referral', async () => {
      // Mock: users query returns a valid referrer
      mockFrom
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            ilike: vi.fn().mockResolvedValue({
              data: [{ id: 'referrer-id' }],
              error: null,
            }),
          }),
        })
        // Mock: existing referral check returns a result
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: [{ id: 'existing-ref' }],
                error: null,
              }),
            }),
          }),
        });

      await expect(
        referralService.applyReferralCode('referee-id', 'REFERRER'),
      ).rejects.toThrow('Ya usaste un código de referido');
    });

    it('creates referral record on valid code', async () => {
      const mockReferral = {
        id: 'new-ref-id',
        referrer_id: 'referrer-id',
        referee_id: 'referee-id',
        code: 'REFERRER',
        status: 'pending',
        bonus_amount: 50000,
      };

      // Mock: users query finds referrer
      mockFrom
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            ilike: vi.fn().mockResolvedValue({
              data: [{ id: 'referrer-id' }],
              error: null,
            }),
          }),
        })
        // Mock: no existing referral
        .mockReturnValueOnce({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          }),
        })
        // Mock: insert succeeds
        .mockReturnValueOnce({
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: mockReferral,
                error: null,
              }),
            }),
          }),
        });

      const result = await referralService.applyReferralCode('referee-id', 'REFERRER');
      expect(result.status).toBe('pending');
      expect(result.bonus_amount).toBe(50000);
      expect(result.referrer_id).toBe('referrer-id');
    });
  });

  describe('getReferralHistory', () => {
    it('returns referrals where user is referrer', async () => {
      const mockHistory = [
        { id: 'ref-1', referrer_id: 'user-1', status: 'rewarded', bonus_amount: 50000 },
        { id: 'ref-2', referrer_id: 'user-1', status: 'pending', bonus_amount: 50000 },
      ];

      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: mockHistory,
              error: null,
            }),
          }),
        }),
      });

      const history = await referralService.getReferralHistory('user-1');
      expect(history).toHaveLength(2);
      expect(history[0]?.status).toBe('rewarded');
      expect(history[1]?.status).toBe('pending');
    });
  });

  describe('hasBeenReferred', () => {
    it('returns true if user has a referral as referee', async () => {
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{ id: 'some-ref' }],
              error: null,
            }),
          }),
        }),
      });

      expect(await referralService.hasBeenReferred('user-1')).toBe(true);
    });

    it('returns false if user has no referral', async () => {
      mockFrom.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [],
              error: null,
            }),
          }),
        }),
      });

      expect(await referralService.hasBeenReferred('user-1')).toBe(false);
    });
  });
});
