// ============================================================
// TriciGo — Destination Suggestions Service
// Thin caller for the get_destination_suggestions RPC (migration 00359):
// personal ride-history clustering blended with a popular-nearby fallback,
// computed server-side so rider / web / driver share one source of truth.
// ============================================================

import type { PredictedDestination, PredictionReason } from '@tricigo/utils';
import { getSupabaseClient } from '../client';

const KNOWN_REASONS: PredictionReason[] = ['frequent', 'time_pattern', 'recent', 'popular'];

// The RPC also emits 'popular' for the global-fallback tier; the shared
// PredictedDestination type only knows the three personal reasons, so map
// 'popular' (and any unexpected value) onto 'frequent'.
function toReason(raw: unknown): PredictionReason {
  return KNOWN_REASONS.includes(raw as PredictionReason) ? (raw as PredictionReason) : 'frequent';
}

export const suggestionsService = {
  /**
   * Fetch destination suggestions for a rider. Throws if the RPC is absent
   * (migration not yet applied) so callers can fall back to the client-side
   * destinationPredictor heuristic.
   */
  async getDestinationSuggestions(params: {
    userId: string;
    lat?: number | null;
    lng?: number | null;
    hour?: number | null;
    limit?: number;
  }): Promise<PredictedDestination[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_destination_suggestions', {
      p_user_id: params.userId,
      p_lat: params.lat ?? null,
      p_lng: params.lng ?? null,
      p_hour: params.hour ?? null,
      p_limit: params.limit ?? 5,
    });
    if (error) throw error;
    return (Array.isArray(data) ? data : []).map((row: Record<string, unknown>) => ({
      address: row.address as string,
      latitude: row.latitude as number,
      longitude: row.longitude as number,
      score: row.score as number,
      reason: toReason(row.reason),
    }));
  },
};
