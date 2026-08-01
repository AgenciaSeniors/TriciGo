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
    accuracy?: number | null;
    /** Timestamp of the GPS fix itself. Without it the row gets the server
     *  insert time, which is what produced the mixed-clock duplicates that
     *  compute_ride_trail_distance_m has to filter out (incident b428022b). */
    recorded_at?: string;
    /** 00537: per-fix UUID minted at capture; UNIQUE (ride_id, client_event_id)
     *  makes replays (task re-delivery, retry-after-timeout) idempotent. */
    client_event_id?: string;
  }): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('ride_location_events').upsert({
      ride_id: params.ride_id,
      driver_id: params.driver_id,
      location: `POINT(${params.longitude} ${params.latitude})`,
      heading: params.heading ?? null,
      speed: params.speed ?? null,
      accuracy: params.accuracy ?? null,
      ...(params.recorded_at ? { recorded_at: params.recorded_at } : {}),
      ...(params.client_event_id ? { client_event_id: params.client_event_id } : {}),
    }, { onConflict: 'ride_id,recorded_at', ignoreDuplicates: true });
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
      /** 00537: per-fix UUID minted at capture (see recordRideLocation). */
      client_event_id?: string;
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
      // 00537: keep (ride_id, recorded_at) as the upsert conflict target
      // (matches idx_ride_location_dedup, which would otherwise 23505 the
      // whole batch); client_event_id rides along for audit + server dedup.
      client_event_id: e.client_event_id ?? null,
    }));
    const { error } = await supabase.from('ride_location_events').upsert(rows, { onConflict: 'ride_id,recorded_at', ignoreDuplicates: true });
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
