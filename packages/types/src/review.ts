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
}
