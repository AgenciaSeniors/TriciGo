import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockSupabase = { from: mockFrom, rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { reviewService } from '../review.service';

describe('reviewService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==================== submitReview ====================
  describe('submitReview', () => {
    it('inserts review and returns it', async () => {
      const mockReview = {
        id: 'rev-1',
        ride_id: 'r-1',
        reviewer_id: 'u-1',
        reviewee_id: 'u-2',
        rating: 5,
        comment: 'Great ride!',
        is_visible: true,
      };
      const mockSingle = vi.fn().mockResolvedValue({ data: mockReview, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      const result = await reviewService.submitReview({
        ride_id: 'r-1',
        reviewer_id: 'u-1',
        reviewee_id: 'u-2',
        rating: 5,
        comment: 'Great ride!',
      });

      expect(mockFrom).toHaveBeenCalledWith('reviews');
      expect(mockInsert).toHaveBeenCalledWith({
        ride_id: 'r-1',
        reviewer_id: 'u-1',
        reviewee_id: 'u-2',
        rating: 5,
        comment: 'Great ride!',
        is_visible: true,
      });
      expect(result).toEqual(mockReview);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Insert failed', code: '23505' };
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await expect(
        reviewService.submitReview({
          ride_id: 'r-1',
          reviewer_id: 'u-1',
          reviewee_id: 'u-2',
          rating: 4,
        }),
      ).rejects.toEqual(err);
    });
  });

  // ==================== getReviewForRide ====================
  describe('getReviewForRide', () => {
    it('returns review for a specific ride and reviewer', async () => {
      const mockReview = { id: 'rev-1', ride_id: 'r-1', reviewer_id: 'u-1', rating: 5 };
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: mockReview, error: null });
      const mockEqReviewer = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockEqRide = vi.fn(() => ({ eq: mockEqReviewer }));
      const mockSelect = vi.fn(() => ({ eq: mockEqRide }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await reviewService.getReviewForRide('r-1', 'u-1');

      expect(mockFrom).toHaveBeenCalledWith('reviews');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEqRide).toHaveBeenCalledWith('ride_id', 'r-1');
      expect(mockEqReviewer).toHaveBeenCalledWith('reviewer_id', 'u-1');
      expect(result).toEqual(mockReview);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEqReviewer = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockEqRide = vi.fn(() => ({ eq: mockEqReviewer }));
      const mockSelect = vi.fn(() => ({ eq: mockEqRide }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(reviewService.getReviewForRide('r-1', 'u-1')).rejects.toEqual(err);
    });
  });

  // ==================== getReviewsForUser ====================
  describe('getReviewsForUser', () => {
    it('returns paginated reviews for a user', async () => {
      const mockReviews = [
        { id: 'rev-1', reviewee_id: 'u-2', rating: 5 },
        { id: 'rev-2', reviewee_id: 'u-2', rating: 4 },
      ];
      const mockRange = vi.fn().mockResolvedValue({ data: mockReviews, error: null });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockEqVisible = vi.fn(() => ({ order: mockOrder }));
      const mockEqUser = vi.fn(() => ({ eq: mockEqVisible }));
      const mockSelect = vi.fn(() => ({ eq: mockEqUser }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const result = await reviewService.getReviewsForUser('u-2', 1, 10);

      expect(mockFrom).toHaveBeenCalledWith('reviews');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEqUser).toHaveBeenCalledWith('reviewee_id', 'u-2');
      expect(mockEqVisible).toHaveBeenCalledWith('is_visible', true);
      expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false });
      // page=1, pageSize=10 => from=10, to=19
      expect(mockRange).toHaveBeenCalledWith(10, 19);
      expect(result).toEqual(mockReviews);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const mockRange = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockOrder = vi.fn(() => ({ range: mockRange }));
      const mockEqVisible = vi.fn(() => ({ order: mockOrder }));
      const mockEqUser = vi.fn(() => ({ eq: mockEqVisible }));
      const mockSelect = vi.fn(() => ({ eq: mockEqUser }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(reviewService.getReviewsForUser('u-2')).rejects.toEqual(err);
    });
  });

  // ==================== getReviewSummary ====================
  describe('getReviewSummary', () => {
    it('calls rpc and returns summary', async () => {
      const mockSummary = {
        average_rating: 4.5,
        total_reviews: 100,
        distribution: { 1: 2, 2: 5, 3: 10, 4: 33, 5: 50 },
      };
      mockRpc.mockResolvedValueOnce({ data: mockSummary, error: null });

      const result = await reviewService.getReviewSummary('u-2');

      expect(mockRpc).toHaveBeenCalledWith('get_review_summary', { p_user_id: 'u-2' });
      expect(result).toEqual(mockSummary);
    });

    it('throws on rpc error', async () => {
      const err = { message: 'RPC failed', code: '500' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });

      await expect(reviewService.getReviewSummary('u-2')).rejects.toEqual(err);
    });
  });
});
