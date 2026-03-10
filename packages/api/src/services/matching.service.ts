// ============================================================
// TriciGo — Matching Service
// Score-based driver matching with weighted composite scoring.
// ============================================================

import type {
  DriverMatchResult,
  DriverScoreEvent,
  ScoreEventType,
} from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const matchingService = {
  /**
   * Find the best drivers for a ride request using
   * weighted multi-factor scoring (proximity, score, rating, acceptance rate).
   */
  async findBestDrivers(params: {
    pickup_lat: number;
    pickup_lng: number;
    service_type: string;
    limit?: number;
    radius_m?: number;
  }): Promise<DriverMatchResult[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('find_best_drivers', {
      p_pickup_lat: params.pickup_lat,
      p_pickup_lng: params.pickup_lng,
      p_service_type: params.service_type,
      p_limit: params.limit ?? 5,
      p_radius_m: params.radius_m ?? 5000,
    });
    if (error) throw error;
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    return rows as DriverMatchResult[];
  },

  /**
   * Update a driver's match score based on an event.
   */
  async updateDriverScore(
    driverId: string,
    eventType: ScoreEventType,
    details?: Record<string, unknown>,
  ): Promise<number> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('update_driver_score', {
      p_driver_id: driverId,
      p_event_type: eventType,
      p_details: details ?? null,
    });
    if (error) throw error;
    return (typeof data === 'number' ? data : 50.0);
  },

  /**
   * Get the driver's current match score.
   */
  async getDriverScore(driverId: string): Promise<{
    match_score: number;
    acceptance_rate: number;
  }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_profiles')
      .select('match_score, acceptance_rate')
      .eq('user_id', driverId)
      .single();
    if (error) throw error;
    return {
      match_score: data?.match_score ?? 50.0,
      acceptance_rate: data?.acceptance_rate ?? 100.0,
    };
  },

  /**
   * Get score event history for a driver.
   */
  async getScoreEvents(
    driverId: string,
    limit = 50,
  ): Promise<DriverScoreEvent[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_score_events')
      .select('*')
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data as DriverScoreEvent[];
  },
};
