import type { RideLocationEvent } from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const locationService = {
  async recordRideLocation(params: {
    ride_id: string;
    driver_id: string;
    latitude: number;
    longitude: number;
    heading?: number;
    speed?: number;
  }): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('ride_location_events').insert({
      ride_id: params.ride_id,
      driver_id: params.driver_id,
      location: `POINT(${params.longitude} ${params.latitude})`,
      heading: params.heading ?? null,
      speed: params.speed ?? null,
    });
    if (error) throw error;
  },

  async calculateRideDistance(
    rideId: string,
  ): Promise<{ distance_m: number; point_count: number }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('calculate_ride_distance', {
      p_ride_id: rideId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return row ?? { distance_m: 0, point_count: 0 };
  },

  /**
   * Get all location events for a completed ride (for route playback/map).
   * Returns coordinates in chronological order.
   */
  async getRideLocationEvents(rideId: string): Promise<RideLocationEvent[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_location_events')
      .select('*')
      .eq('ride_id', rideId)
      .order('recorded_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as RideLocationEvent[];
  },

  /**
   * Bulk-insert buffered location events (used when flushing offline GPS buffer).
   */
  async bulkRecordRideLocations(
    events: Array<{
      ride_id: string;
      driver_id: string;
      latitude: number;
      longitude: number;
      heading?: number;
      speed?: number;
      accuracy?: number | null;
      recorded_at: string;
    }>,
  ): Promise<void> {
    if (events.length === 0) return;
    const supabase = getSupabaseClient();
    // Deduplicate by (ride_id, recorded_at) — prevents double-flush on reconnect
    const seen = new Set<string>();
    const dedupedEvents = events.filter((e) => {
      const key = `${e.ride_id}:${e.recorded_at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const rows = dedupedEvents.map((e) => ({
      ride_id: e.ride_id,
      driver_id: e.driver_id,
      location: `POINT(${e.longitude} ${e.latitude})`,
      heading: e.heading ?? null,
      speed: e.speed ?? null,
      accuracy: e.accuracy ?? null,
      recorded_at: e.recorded_at,
    }));
    const { error } = await supabase.from('ride_location_events').insert(rows);
    if (error) throw error;
  },

  async getLatestLocation(
    rideId: string,
  ): Promise<RideLocationEvent | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_location_events')
      .select('*')
      .eq('ride_id', rideId)
      .order('recorded_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as RideLocationEvent | null;
  },
};
