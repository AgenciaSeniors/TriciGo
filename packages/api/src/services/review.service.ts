// ============================================================
// TriciGo — Review Service
// ============================================================

import type {
  Review,
  ReviewSummary,
  ReviewTagDefinition,
  ReviewTag,
  ReviewWithReviewer,
} from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { validate, submitReviewSchema } from '../schemas';

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
    const validParams = validate(submitReviewSchema, params);
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('reviews')
      .insert({
        ride_id: validParams.ride_id,
        reviewer_id: validParams.reviewer_id,
        reviewee_id: validParams.reviewee_id,
        rating: validParams.rating,
        comment: validParams.comment ?? null,
        is_visible: true,
      })
      .select()
      .single();
    if (error) throw error;

    // Insert tags if provided — if this fails, delete the orphaned review
    if (validParams.tags && validParams.tags.length > 0) {
      const { error: tagError } = await supabase
        .from('review_tags')
        .insert(validParams.tags.map((tag_key) => ({ review_id: data.id, tag_key })));
      if (tagError) {
        // Rollback: delete the review to avoid orphaned record
        try {
          await supabase.from('reviews').delete().eq('id', data.id);
        } catch { /* best effort cleanup */ }
        throw tagError;
      }
    }

    return { ...data, tags: validParams.tags ?? [] } as Review;
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

  /**
   * Get reviews with reviewer display info and tags.
   * Used for driver profile screen.
   */
  async getReviewsWithReviewerInfo(
    userId: string,
    limit = 10,
  ): Promise<ReviewWithReviewer[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('reviews')
      .select(`
        *,
        reviewer:users!reviewer_id(first_name, avatar_url),
        review_tags(
          tag_key,
          tag_def:review_tag_definitions!tag_key(
            key,
            label_es,
            label_en,
            label_pt,
            sentiment
          )
        )
      `)
      .eq('reviewee_id', userId)
      .eq('is_visible', true)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;

    // Map Supabase joined shape to our ReviewWithReviewer interface
    return (data ?? []).map((row: Record<string, unknown>) => {
      const reviewer = row.reviewer as Record<string, unknown> | null;
      const tags = (row.review_tags as Array<Record<string, unknown>>) ?? [];
      return {
        id: row.id as string,
        ride_id: row.ride_id as string,
        reviewer_id: row.reviewer_id as string,
        reviewee_id: row.reviewee_id as string,
        rating: row.rating as 1 | 2 | 3 | 4 | 5,
        comment: row.comment as string | null,
        is_visible: row.is_visible as boolean,
        created_at: row.created_at as string,
        tags: row.tags as string[] | undefined,
        reviewer_first_name: (reviewer?.first_name as string) ?? '',
        reviewer_avatar_url: (reviewer?.avatar_url as string) ?? null,
        review_tags: tags.map((t) => {
          const def = t.tag_def as Record<string, unknown> | null;
          return {
            key: (def?.key as string) ?? (t.tag_key as string),
            label_es: (def?.label_es as string) ?? '',
            label_en: (def?.label_en as string) ?? '',
            label_pt: (def?.label_pt as string) ?? '',
            sentiment: (def?.sentiment as string) ?? 'positive',
          };
        }),
      } as ReviewWithReviewer;
    });
  },

  /**
   * Get public driver profile data: review summary + top tags.
   */
  async getDriverPublicProfile(driverUserId: string): Promise<{
    summary: ReviewSummary;
    recentReviews: ReviewWithReviewer[];
  }> {
    const [summary, recentReviews] = await Promise.all([
      reviewService.getReviewSummary(driverUserId),
      reviewService.getReviewsWithReviewerInfo(driverUserId, 10),
    ]);
    return { summary, recentReviews };
  },
};
