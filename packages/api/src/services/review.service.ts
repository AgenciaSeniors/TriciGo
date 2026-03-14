// ============================================================
// TriciGo — Review Service
// ============================================================

import type {
  Review,
  ReviewSummary,
  ReviewTagDefinition,
  ReviewTag,
} from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const reviewService = {
  /**
   * Submit a review for a completed ride.
   * Optionally include tag keys for categorized feedback.
   */
  async submitReview(params: {
    ride_id: string;
    reviewer_id: string;
    reviewee_id: string;
    rating: 1 | 2 | 3 | 4 | 5;
    comment?: string;
    tags?: string[];
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

    // Insert tags if provided
    if (params.tags && params.tags.length > 0) {
      const { error: tagError } = await supabase
        .from('review_tags')
        .insert(params.tags.map((tag_key) => ({ review_id: data.id, tag_key })));
      if (tagError) throw tagError;
    }

    return { ...data, tags: params.tags ?? [] } as Review;
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
   * Get review summary (average rating + distribution + top tags).
   */
  async getReviewSummary(userId: string): Promise<ReviewSummary> {
    const supabase = getSupabaseClient();
    const [summaryRes, tagsRes] = await Promise.all([
      supabase.rpc('get_review_summary', { p_user_id: userId }),
      supabase.rpc('get_review_tag_summary', { p_user_id: userId }),
    ]);
    if (summaryRes.error) throw summaryRes.error;
    const summary = summaryRes.data as ReviewSummary;
    if (!tagsRes.error && tagsRes.data) {
      summary.top_tags = tagsRes.data;
    }
    return summary;
  },

  /**
   * Get active tag definitions filtered by direction and sentiment.
   */
  async getTagDefinitions(
    direction: string,
    sentiment: string,
  ): Promise<ReviewTagDefinition[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('review_tag_definitions')
      .select('*')
      .eq('direction', direction)
      .eq('sentiment', sentiment)
      .eq('is_active', true)
      .order('display_order', { ascending: true });
    if (error) throw error;
    return data as ReviewTagDefinition[];
  },

  /**
   * Get tags for a specific review.
   */
  async getReviewTags(reviewId: string): Promise<ReviewTag[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('review_tags')
      .select('*')
      .eq('review_id', reviewId);
    if (error) throw error;
    return data as ReviewTag[];
  },
};
