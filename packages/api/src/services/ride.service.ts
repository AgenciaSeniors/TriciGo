// ============================================================
// TriciGo — Ride Service
// Ride lifecycle operations.
// ============================================================

import type {
  Ride,
  RideWithDriver,
  RidePricingSnapshot,
  RideTransition,
  FareEstimate,
} from '@tricigo/types';
import type { PaymentMethod, RideStatus, ServiceTypeSlug } from '@tricigo/types';
import { getSupabaseClient } from '../client';

export interface CreateRideParams {
  service_type: ServiceTypeSlug;
  payment_method: PaymentMethod;
  pickup_latitude: number;
  pickup_longitude: number;
  pickup_address: string;
  dropoff_latitude: number;
  dropoff_longitude: number;
  dropoff_address: string;
  scheduled_at?: string;
}

export const rideService = {
  /**
   * Get fare estimate before requesting a ride.
   */
  async getFareEstimate(params: {
    service_type: ServiceTypeSlug;
    pickup_lat: number;
    pickup_lng: number;
    dropoff_lat: number;
    dropoff_lng: number;
  }): Promise<FareEstimate> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('estimate_fare', {
      p_service_type: params.service_type,
      p_pickup_lat: params.pickup_lat,
      p_pickup_lng: params.pickup_lng,
      p_dropoff_lat: params.dropoff_lat,
      p_dropoff_lng: params.dropoff_lng,
    });
    if (error) throw error;
    return data as FareEstimate;
  },

  /**
   * Request a new ride.
   */
  async createRide(params: CreateRideParams): Promise<Ride> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('rides')
      .insert({
        service_type: params.service_type,
        payment_method: params.payment_method,
        pickup_location: `POINT(${params.pickup_longitude} ${params.pickup_latitude})`,
        pickup_address: params.pickup_address,
        dropoff_location: `POINT(${params.dropoff_longitude} ${params.dropoff_latitude})`,
        dropoff_address: params.dropoff_address,
        scheduled_at: params.scheduled_at ?? null,
        is_scheduled: !!params.scheduled_at,
        status: 'searching' as RideStatus,
      })
      .select()
      .single();
    if (error) throw error;
    return data as Ride;
  },

  /**
   * Get a ride with driver details.
   */
  async getRideWithDriver(rideId: string): Promise<RideWithDriver | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .rpc('get_ride_with_driver', { p_ride_id: rideId });
    if (error) throw error;
    return data as RideWithDriver | null;
  },

  /**
   * Get the active ride for the current user (if any).
   */
  async getActiveRide(userId: string): Promise<Ride | null> {
    const supabase = getSupabaseClient();
    const activeStatuses: RideStatus[] = [
      'searching', 'accepted', 'driver_en_route',
      'arrived_at_pickup', 'in_progress',
    ];

    const { data, error } = await supabase
      .from('rides')
      .select('*')
      .eq('customer_id', userId)
      .in('status', activeStatuses)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as Ride | null;
  },

  /**
   * Cancel a ride.
   */
  async cancelRide(rideId: string, reason?: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('rides')
      .update({
        status: 'canceled' as RideStatus,
        cancellation_reason: reason ?? null,
      })
      .eq('id', rideId);
    if (error) throw error;
  },

  /**
   * Get ride history for a user.
   */
  async getRideHistory(
    userId: string,
    page = 0,
    pageSize = 20,
  ): Promise<Ride[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('rides')
      .select('*')
      .eq('customer_id', userId)
      .in('status', ['completed', 'canceled'])
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data as Ride[];
  },

  /**
   * Get pricing snapshot for a ride.
   */
  async getPricingSnapshot(rideId: string): Promise<RidePricingSnapshot | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_pricing_snapshots')
      .select('*')
      .eq('ride_id', rideId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as RidePricingSnapshot | null;
  },

  /**
   * Get transition history for a ride.
   */
  async getTransitions(rideId: string): Promise<RideTransition[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_transitions')
      .select('*')
      .eq('ride_id', rideId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data as RideTransition[];
  },

  /**
   * Subscribe to ride status changes (Postgres Changes).
   */
  subscribeToRide(rideId: string, onUpdate: (ride: Ride) => void) {
    const supabase = getSupabaseClient();
    return supabase
      .channel(`ride:${rideId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rides',
          filter: `id=eq.${rideId}`,
        },
        (payload) => {
          onUpdate(payload.new as Ride);
        },
      )
      .subscribe();
  },
};
