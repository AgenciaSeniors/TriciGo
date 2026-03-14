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

  // ─── createRechargeLink ───
  describe('createRechargeLink', () => {
    it('calls create-tropipay-link edge function with correct params', async () => {
      const mockResponse = {
        paymentUrl: 'https://tropipay.com/pay/abc',
        shortUrl: 'https://tppay.me/abc',
        intentId: 'intent-123',
      };
      mockInvoke.mockResolvedValue({ data: mockResponse, error: null });

      const result = await paymentService.createRechargeLink('user-1', 5000);

      expect(mockInvoke).toHaveBeenCalledWith('create-tropipay-link', {
        body: { user_id: 'user-1', amount_cup: 5000 },
      });
      expect(result).toEqual(mockResponse);
    });

    it('throws on edge function error', async () => {
      mockInvoke.mockResolvedValue({
        data: null,
        error: new Error('Edge function failed'),
      });

      await expect(paymentService.createRechargeLink('user-1', 5000)).rejects.toThrow(
        'Edge function failed',
      );
    });
  });

  // ─── createRidePaymentLink ───
  describe('createRidePaymentLink', () => {
    it('calls create-ride-payment-link edge function with ride_id', async () => {
      const mockResponse = {
        paymentUrl: 'https://tropipay.com/pay/xyz',
        shortUrl: 'https://tppay.me/xyz',
        intentId: 'intent-456',
        amountCup: 750,
        amountUsd: 1.44,
      };
      mockInvoke.mockResolvedValue({ data: mockResponse, error: null });

      const result = await paymentService.createRidePaymentLink('ride-abc');

      expect(mockInvoke).toHaveBeenCalledWith('create-ride-payment-link', {
        body: { ride_id: 'ride-abc' },
      });
      expect(result).toEqual(mockResponse);
    });

    it('throws on edge function error', async () => {
      mockInvoke.mockResolvedValue({
        data: null,
        error: new Error('Payment link creation failed'),
      });

      await expect(paymentService.createRidePaymentLink('ride-abc')).rejects.toThrow(
        'Payment link creation failed',
      );
    });

    it('returns all expected fields', async () => {
      const mockResponse = {
        paymentUrl: 'https://tropipay.com/pay/xyz',
        shortUrl: 'https://tppay.me/xyz',
        intentId: 'intent-789',
        amountCup: 1500,
        amountUsd: 2.88,
      };
      mockInvoke.mockResolvedValue({ data: mockResponse, error: null });

      const result = await paymentService.createRidePaymentLink('ride-def');

      expect(result.paymentUrl).toBeDefined();
      expect(result.shortUrl).toBeDefined();
      expect(result.intentId).toBeDefined();
      expect(result.amountCup).toBe(1500);
      expect(result.amountUsd).toBe(2.88);
    });
  });

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
