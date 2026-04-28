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

    // BUG-264 v2 — robust submission with three layers of safety:
    //
    //   Layer 1: PRE-FLIGHT CHECK
    //     Many "review failed" reports were false negatives — the previous
    //     attempt actually succeeded server-side but the response was lost
    //     in the network. Before we INSERT, look for an existing review
    //     for (ride_id, reviewer_id). If one exists, return it as success.
    //
    //   Layer 2: RETRY ON TRANSIENT NETWORK ERRORS
    //     Cuban networks drop packets intermittently. We try up to 3 times
    //     with 500ms / 1000ms backoff. Before each retry we re-check if
    //     the review exists (one of the earlier attempts may have made it
    //     through).
    //
    //   Layer 3: DUPLICATE-KEY RECOVERY
    //     If the INSERT lands but PostgREST hits the unique constraint
    //     (23505 / uniq_reviews_ride_reviewer), the review is already in
    //     the DB. Fetch it and return as success.
    //
    // Any "throw" path means we have exhausted all 3 layers AND there's no
    // existing review server-side — a real failure the caller must report.

    const findExistingReview = async (): Promise<Review | null> => {
      try {
        const { data, error } = await supabase
          .from('reviews')
          .select('*')
          .eq('ride_id', validParams.ride_id)
          .eq('reviewer_id', validParams.reviewer_id)
          .maybeSingle();
        if (error) return null;
        return data as Review | null;
      } catch {
        return null;
      }
    };

    // Layer 1: pre-flight
    const preExisting = await findExistingReview();
    if (preExisting) {
      // eslint-disable-next-line no-console
      console.log('[reviewService] review already exists, treating as success', {
        ride_id: validParams.ride_id,
        review_id: preExisting.id,
      });
      return { ...preExisting, tags: validParams.tags ?? [] } as Review;
    }

    const isDuplicateError = (err: unknown): boolean => {
      const e = err as { code?: string; message?: string } | null | undefined;
      if (!e) return false;
      const msg = String(e.message ?? '');
      return e.code === '23505'
        || /duplicate key value/i.test(msg)
        || /uniq_reviews_ride_reviewer|reviews_ride_id_reviewer_id_key/i.test(msg);
    };

    // Layer 2 + 3: retry loop with duplicate-key recovery
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
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

        if (!error) {
          // SUCCESS — insert tags then return
          if (validParams.tags && validParams.tags.length > 0) {
            const { error: tagError } = await supabase
              .from('review_tags')
              .insert(validParams.tags.map((tag_key) => ({ review_id: data.id, tag_key })));
            if (tagError) {
              // Rollback to avoid orphaned review
              try { await supabase.from('reviews').delete().eq('id', data.id); } catch { /* best effort */ }
              throw tagError;
            }
          }
          return { ...data, tags: validParams.tags ?? [] } as Review;
        }

        // Layer 3: duplicate-key recovery (race with another tab/retry)
        if (isDuplicateError(error)) {
          const existing = await findExistingReview();
          if (existing) {
            // eslint-disable-next-line no-console
            console.log('[reviewService] insert hit unique constraint — fetched existing', {
              ride_id: validParams.ride_id,
              review_id: existing.id,
            });
            return { ...existing, tags: validParams.tags ?? [] } as Review;
          }
        }
        lastErr = error;
      } catch (err) {
        lastErr = err;
        // Network exception during INSERT. Before next retry, check if the
        // review now exists — the failed call may have actually succeeded.
        const recovered = await findExistingReview();
        if (recovered) {
          // eslint-disable-next-line no-console
          console.log('[reviewService] network exception but review found — recovered', {
            ride_id: validParams.ride_id,
            review_id: recovered.id,
            err: String((err as { message?: string })?.message ?? err),
          });
          return { ...recovered, tags: validParams.tags ?? [] } as Review;
        }
      }
      if (attempt < 3) {
        await new Promise<void>((r) => setTimeout(r, attempt * 500));
      }
    }

    // All retries exhausted with no review found server-side. Throw a
    // real Error (not a Supabase error object) so logger.error doesn't
    // serialize as "[object Object]".
    const errStr = (() => {
      try { return JSON.stringify(lastErr); } catch { return String(lastErr); }
    })();
    throw new Error(`submitReview failed after 3 attempts: ${errStr}`);
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
