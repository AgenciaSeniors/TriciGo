import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockQueryChain, UUID } from './helpers/mockSupabase';

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
    it('inserts review without tags and returns it', async () => {
      const mockReview = {
        id: UUID.REVIEW_1,
        ride_id: UUID.RIDE_1,
        reviewer_id: UUID.USER_1,
        reviewee_id: UUID.USER_2,
        rating: 5,
        comment: 'Great ride!',
        is_visible: true,
      };
      const mockSingle = vi.fn().mockResolvedValue({ data: mockReview, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      const result = await reviewService.submitReview({
        ride_id: UUID.RIDE_1,
        reviewer_id: UUID.USER_1,
        reviewee_id: UUID.USER_2,
        rating: 5,
        comment: 'Great ride!',
      });

      expect(mockFrom).toHaveBeenCalledWith('reviews');
      expect(mockInsert).toHaveBeenCalledWith({
        ride_id: UUID.RIDE_1,
        reviewer_id: UUID.USER_1,
        reviewee_id: UUID.USER_2,
        rating: 5,
        comment: 'Great ride!',
        is_visible: true,
      });
      expect(result.id).toBe(UUID.REVIEW_1);
      expect(result.tags).toEqual([]);
    });

    it('inserts review with tags', async () => {
      const mockReview = { id: UUID.REVIEW_2, ride_id: UUID.RIDE_1, reviewer_id: UUID.USER_1, reviewee_id: UUID.USER_2, rating: 5 };
      const mockSingle = vi.fn().mockResolvedValue({ data: mockReview, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));
      const mockTagInsert = vi.fn().mockResolvedValue({ error: null });

      mockFrom
        .mockReturnValueOnce({ insert: mockInsert })          // reviews insert
        .mockReturnValueOnce({ insert: mockTagInsert });       // review_tags insert

      const result = await reviewService.submitReview({
        ride_id: UUID.RIDE_1,
        reviewer_id: UUID.USER_1,
        reviewee_id: UUID.USER_2,
        rating: 5,
        tags: ['clean_vehicle', 'smooth_driving'],
      });

      expect(mockTagInsert).toHaveBeenCalledWith([
        { review_id: UUID.REVIEW_2, tag_key: 'clean_vehicle' },
        { review_id: UUID.REVIEW_2, tag_key: 'smooth_driving' },
      ]);
      expect(result.tags).toEqual(['clean_vehicle', 'smooth_driving']);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Insert failed', code: '23505' };
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockInsert = vi.fn(() => ({ select: mockSelect }));

      mockFrom.mockReturnValueOnce({ insert: mockInsert });

      await expect(
        reviewService.submitReview({
          ride_id: UUID.RIDE_1,
          reviewer_id: UUID.USER_1,
          reviewee_id: UUID.USER_2,
          rating: 4,
        }),
      ).rejects.toEqual(err);
    });
  });

  // ==================== getReviewForRide ====================
  describe('getReviewForRide', () => {
    it('returns review for a specific ride and reviewer', async () => {
      const mockReview = { id: UUID.REVIEW_1, ride_id: UUID.RIDE_1, reviewer_id: UUID.USER_1, rating: 5 };
      const chain = createMockQueryChain({ data: mockReview, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await reviewService.getReviewForRide(UUID.RIDE_1, UUID.USER_1);

      expect(mockFrom).toHaveBeenCalledWith('reviews');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.eq).toHaveBeenCalledWith('ride_id', UUID.RIDE_1);
      expect(chain.eq).toHaveBeenCalledWith('reviewer_id', UUID.USER_1);
      expect(result).toEqual(mockReview);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      chain.maybeSingle.mockResolvedValue({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(reviewService.getReviewForRide(UUID.RIDE_1, UUID.USER_1)).rejects.toEqual(err);
    });
  });

  // ==================== getReviewsForUser ====================
  describe('getReviewsForUser', () => {
    it('returns paginated reviews for a user', async () => {
      const mockReviews = [
        { id: UUID.REVIEW_1, reviewee_id: UUID.USER_2, rating: 5 },
        { id: UUID.REVIEW_2, reviewee_id: UUID.USER_2, rating: 4 },
      ];
      const chain = createMockQueryChain({ data: mockReviews, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await reviewService.getReviewsForUser(UUID.USER_2, 1, 10);

      expect(mockFrom).toHaveBeenCalledWith('reviews');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.eq).toHaveBeenCalledWith('reviewee_id', UUID.USER_2);
      expect(chain.eq).toHaveBeenCalledWith('is_visible', true);
      expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(chain.range).toHaveBeenCalledWith(10, 19);
      expect(result).toEqual(mockReviews);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'DB error', code: '42P01' };
      const chain = createMockQueryChain({ data: null, error: err });
      mockFrom.mockReturnValueOnce(chain);

      await expect(reviewService.getReviewsForUser(UUID.USER_2)).rejects.toEqual(err);
    });
  });

  // ==================== getReviewSummary ====================
  describe('getReviewSummary', () => {
    it('returns summary with top tags', async () => {
      const mockSummary = {
        average_rating: 4.5,
        total_reviews: 100,
        rating_distribution: { 1: 2, 2: 5, 3: 10, 4: 33, 5: 50 },
      };
      const topTags = [
        { tag_key: 'clean_vehicle', count: 15 },
        { tag_key: 'smooth_driving', count: 12 },
      ];
      mockRpc
        .mockResolvedValueOnce({ data: mockSummary, error: null })
        .mockResolvedValueOnce({ data: topTags, error: null });

      const result = await reviewService.getReviewSummary(UUID.USER_2);

      expect(mockRpc).toHaveBeenCalledWith('get_review_summary', { p_user_id: UUID.USER_2 });
      expect(mockRpc).toHaveBeenCalledWith('get_review_tag_summary', { p_user_id: UUID.USER_2 });
      expect(result.average_rating).toBe(4.5);
      expect(result.top_tags).toEqual(topTags);
    });

    it('returns summary without tags when tag RPC fails', async () => {
      const mockSummary = {
        average_rating: 4.0,
        total_reviews: 5,
        rating_distribution: { 1: 0, 2: 0, 3: 1, 4: 2, 5: 2 },
      };
      mockRpc
        .mockResolvedValueOnce({ data: mockSummary, error: null })
        .mockResolvedValueOnce({ data: null, error: { message: 'RPC not found' } });

      const result = await reviewService.getReviewSummary(UUID.USER_2);
      expect(result.average_rating).toBe(4.0);
      expect(result.top_tags).toBeUndefined();
    });

    it('throws on summary rpc error', async () => {
      const err = { message: 'RPC failed', code: '500' };
      mockRpc
        .mockResolvedValueOnce({ data: null, error: err })
        .mockResolvedValueOnce({ data: [], error: null });

      await expect(reviewService.getReviewSummary(UUID.USER_2)).rejects.toEqual(err);
    });
  });

  // ==================== getTagDefinitions ====================
  describe('getTagDefinitions', () => {
    it('fetches tag definitions by direction and sentiment', async () => {
      const tags = [
        { key: 'clean_vehicle', direction: 'rider_to_driver', sentiment: 'positive', display_order: 1, is_active: true },
        { key: 'smooth_driving', direction: 'rider_to_driver', sentiment: 'positive', display_order: 4, is_active: true },
      ];
      const chain = createMockQueryChain({ data: tags, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await reviewService.getTagDefinitions('rider_to_driver', 'positive');
      expect(mockFrom).toHaveBeenCalledWith('review_tag_definitions');
      expect(chain.eq).toHaveBeenCalledWith('direction', 'rider_to_driver');
      expect(chain.eq).toHaveBeenCalledWith('sentiment', 'positive');
      expect(chain.eq).toHaveBeenCalledWith('is_active', true);
      expect(result).toEqual(tags);
    });
  });

  // ==================== getReviewTags ====================
  describe('getReviewTags', () => {
    it('returns tags for a review', async () => {
      const tags = [
        { id: 'rt-1', review_id: UUID.REVIEW_1, tag_key: 'clean_vehicle', created_at: '2024-01-01T00:00:00Z' },
        { id: 'rt-2', review_id: UUID.REVIEW_1, tag_key: 'smooth_driving', created_at: '2024-01-01T00:00:00Z' },
      ];
      const chain = createMockQueryChain({ data: tags, error: null });
      mockFrom.mockReturnValueOnce(chain);

      const result = await reviewService.getReviewTags(UUID.REVIEW_1);
      expect(mockFrom).toHaveBeenCalledWith('review_tags');
      expect(chain.eq).toHaveBeenCalledWith('review_id', UUID.REVIEW_1);
      expect(result).toEqual(tags);
    });
  });
});
