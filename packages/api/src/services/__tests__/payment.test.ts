import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockInvoke = vi.fn();
const mockSingle = vi.fn();
const mockSelect = vi.fn(() => ({ eq: vi.fn(() => ({ single: mockSingle })) }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));
const mockLimit = vi.fn();
const mockRange = vi.fn();
const mockOrder = vi.fn(() => ({ range: mockRange, limit: mockLimit }));
const mockIn = vi.fn(() => ({ order: vi.fn(() => ({ limit: mockLimit })) }));
const mockSupabase = {
  from: mockFrom,
  functions: { invoke: mockInvoke },
};

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock
import { paymentService } from '../payment.service';

describe('paymentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // TODO: Add tests for Stripe PaymentIntent creation when implemented

  // ─── getPaymentIntent ───
  describe('getPaymentIntent', () => {
    it('returns payment intent by ID', async () => {
      const mockIntent = {
        id: 'intent-123',
        user_id: 'user-1',
        status: 'completed',
        amount_trc: 144,
      };
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: mockIntent, error: null }),
          }),
        }),
      });

      const result = await paymentService.getPaymentIntent('intent-123');
      expect(result).toEqual(mockIntent);
    });

    it('returns null when intent not found (PGRST116)', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: { code: 'PGRST116', message: 'Not found' },
            }),
          }),
        }),
      });

      const result = await paymentService.getPaymentIntent('nonexistent');
      expect(result).toBeNull();
    });

    it('throws on other database errors', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: { code: 'UNEXPECTED', message: 'Database error' },
            }),
          }),
        }),
      });

      await expect(paymentService.getPaymentIntent('intent-123')).rejects.toEqual({
        code: 'UNEXPECTED',
        message: 'Database error',
      });
    });
  });
});
