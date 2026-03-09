// ============================================================
// TriciGo — Review Service
// ============================================================

import type { Review, ReviewSummary } from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const reviewService = {
  /**
   * Submit a review for a completed ride.
   */
  async submitReview(params: {
    ride_id: string;
    reviewer_id: string;
    reviewee_id: string;
    rating: 1 | 2 | 3 | 4 | 5;
    comment?: string;
  }): Promise<Review> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('reviews')
      .insert({
        ride_id: params.ride_id,
        reviewer_id: params.reviewer_id,
        reviewee_id: params.reviewee_id,
        rating: params.rating,
        comment: params.comment ?? null,
        is_visible: true,
      })
      .select()
      .single();
    if (error) throw error;
    return data as Review;
  },

  /**
   * Get the review for a specific ride by a specific reviewer.
   */
  async getReviewForRide(
    rideId: string,
    reviewerId: string,
  ): Promise<Review | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('reviews')
      .select('*')
      .eq('ride_id', rideId)
      .eq('reviewer_id', reviewerId)
      .maybeSingle();
    if (error) throw error;
    return data as Review | null;
  },

  /**
   * Get reviews received by a user.
   */
  async getReviewsForUser(
    userId: string,
    page = 0,
    pageSize = 20,
  ): Promise<Review[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('reviews')
      .select('*')
      .eq('reviewee_id', userId)
      .eq('is_visible', true)
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data as Review[];
  },

  /**
   * Get review summary (average rating + distribution).
   */
  async getReviewSummary(userId: string): Promise<ReviewSummary> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .rpc('get_review_summary', { p_user_id: userId });
    if (error) throw error;
    return data as ReviewSummary;
  },
};
