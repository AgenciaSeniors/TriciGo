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
