// ============================================================
// TriciGo — Review Types
// Bilateral: customer ↔ driver
// ============================================================

export interface Review {
  id: string;
  ride_id: string;
  reviewer_id: string;
  reviewee_id: string;
  rating: 1 | 2 | 3 | 4 | 5;
  comment: string | null;
  is_visible: boolean;
  created_at: string;
  tags?: string[];
}

export interface ReviewSummary {
  user_id: string;
  average_rating: number;
  total_reviews: number;
  rating_distribution: {
    1: number;
    2: number;
    3: number;
    4: number;
    5: number;
  };
  top_tags?: ReviewTagSummaryItem[];
}

// ── Tag-based categorized ratings ───────────────────────────

export type ReviewTagDirection = 'rider_to_driver' | 'driver_to_rider';
export type ReviewTagSentiment = 'positive' | 'negative';

export interface ReviewTagDefinition {
  key: string;
  direction: ReviewTagDirection;
  sentiment: ReviewTagSentiment;
  display_order: number;
  is_active: boolean;
}

export interface ReviewTag {
  id: string;
  review_id: string;
  tag_key: string;
  created_at: string;
}

export interface ReviewTagSummaryItem {
  tag_key: string;
  count: number;
}

/** Review with reviewer display info and tags for driver profile screen */
export interface ReviewWithReviewer extends Review {
  reviewer_first_name: string;
  reviewer_avatar_url: string | null;
  review_tags: Array<{
    key: string;
    label_es: string;
    label_en: string;
    label_pt: string;
    sentiment: ReviewTagSentiment;
  }>;
}
