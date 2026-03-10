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
  ServiceTypeConfig,
  Promotion,
  Tip,
  SurgeZone,
} from '@tricigo/types';
import type { PaymentMethod, RideStatus, ServiceTypeSlug } from '@tricigo/types';
import {
  haversineDistance,
  estimateRoadDistance,
  estimateDuration,
} from '@tricigo/utils';
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
  estimated_fare_cup?: number;
  estimated_distance_m?: number;
  estimated_duration_s?: number;
  scheduled_at?: string;
  promo_code_id?: string;
  discount_amount_cup?: number;
}

export const rideService = {
  /**
   * Get fare estimate using local calculation (no RPC needed).
   * Fetches service_type_configs and computes fare with Haversine distance.
   */
  async getLocalFareEstimate(params: {
    service_type: ServiceTypeSlug;
    pickup_lat: number;
    pickup_lng: number;
    dropoff_lat: number;
    dropoff_lng: number;
  }): Promise<FareEstimate> {
    const supabase = getSupabaseClient();

    // Fetch the service config for pricing
    const { data: config, error } = await supabase
      .from('service_type_configs')
      .select('*')
      .eq('slug', params.service_type)
      .eq('is_active', true)
      .single();
    if (error) throw error;

    const svcConfig = config as ServiceTypeConfig;
    const pickup = { latitude: params.pickup_lat, longitude: params.pickup_lng };
    const dropoff = { latitude: params.dropoff_lat, longitude: params.dropoff_lng };

    const straightLine = haversineDistance(pickup, dropoff);
    const roadDistance = estimateRoadDistance(straightLine);
    const duration = estimateDuration(roadDistance, params.service_type);

    const distanceKm = roadDistance / 1000;
    const durationMin = duration / 60;

    const fare = Math.round(
      svcConfig.base_fare_cup +
      distanceKm * svcConfig.per_km_rate_cup +
      durationMin * svcConfig.per_minute_rate_cup,
    );

    const finalFare = Math.max(fare, svcConfig.min_fare_cup);

    return {
      service_type: params.service_type,
      estimated_fare_cup: finalFare,
      estimated_distance_m: Math.round(roadDistance),
      estimated_duration_s: duration,
      surge_multiplier: 1.0,
      pricing_rule_id: svcConfig.id,
    };
  },

  /**
   * Get fare estimate via RPC (if available, falls back to local).
   */
  async getFareEstimate(params: {
    service_type: ServiceTypeSlug;
    pickup_lat: number;
    pickup_lng: number;
    dropoff_lat: number;
    dropoff_lng: number;
  }): Promise<FareEstimate> {
    // Use local calculation (RPC not deployed)
    return this.getLocalFareEstimate(params);
  },

  /**
   * Request a new ride.
   */
  async createRide(params: CreateRideParams): Promise<Ride> {
    const supabase = getSupabaseClient();

    // Get current user for customer_id
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');

    const { data, error } = await supabase
      .from('rides')
      .insert({
        customer_id: user.id,
        service_type: params.service_type,
        payment_method: params.payment_method,
        pickup_location: `POINT(${params.pickup_longitude} ${params.pickup_latitude})`,
        pickup_address: params.pickup_address,
        dropoff_location: `POINT(${params.dropoff_longitude} ${params.dropoff_latitude})`,
        dropoff_address: params.dropoff_address,
        estimated_fare_cup: params.estimated_fare_cup ?? 0,
        estimated_distance_m: params.estimated_distance_m ?? 0,
        estimated_duration_s: params.estimated_duration_s ?? 0,
        scheduled_at: params.scheduled_at ?? null,
        is_scheduled: !!params.scheduled_at,
        promo_code_id: params.promo_code_id ?? null,
        discount_amount_cup: params.discount_amount_cup ?? 0,
        status: 'searching' as RideStatus,
      })
      .select()
      .single();
    if (error) throw error;

    // Record promo usage if applicable
    if (params.promo_code_id && data) {
      await supabase.from('promotion_uses').insert({
        promotion_id: params.promo_code_id,
        user_id: user.id,
        ride_id: (data as Ride).id,
      });
      await supabase.rpc('increment_promo_uses', {
        p_promo_id: params.promo_code_id,
      });
    }

    return data as Ride;
  },

  /**
   * Get a ride with driver details (manual join).
   */
  async getRideWithDriver(rideId: string): Promise<RideWithDriver | null> {
    const supabase = getSupabaseClient();

    // Fetch the ride
    const { data: ride, error: rideError } = await supabase
      .from('rides')
      .select('*')
      .eq('id', rideId)
      .maybeSingle();
    if (rideError) throw rideError;
    if (!ride) return null;

    const rideData = ride as Ride;
    const result: RideWithDriver = {
      ...rideData,
      driver_user_id: null,
      driver_name: null,
      driver_avatar_url: null,
      driver_rating: null,
      driver_phone: null,
      vehicle_make: null,
      vehicle_model: null,
      vehicle_color: null,
      vehicle_plate: null,
    };

    // If driver assigned, fetch details
    if (rideData.driver_id) {
      const { data: driverProfile } = await supabase
        .from('driver_profiles')
        .select('user_id, rating_avg')
        .eq('id', rideData.driver_id)
        .single();

      if (driverProfile) {
        result.driver_user_id = driverProfile.user_id;
        result.driver_rating = driverProfile.rating_avg;

        // Fetch user info for driver name/phone
        const { data: driverUser } = await supabase
          .from('users')
          .select('full_name, phone, avatar_url')
          .eq('id', driverProfile.user_id)
          .single();

        if (driverUser) {
          result.driver_name = driverUser.full_name;
          result.driver_avatar_url = driverUser.avatar_url;
          result.driver_phone = driverUser.phone;
        }

        // Fetch vehicle
        const { data: vehicle } = await supabase
          .from('vehicles')
          .select('make, model, color, plate_number')
          .eq('driver_id', rideData.driver_id)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle();

        if (vehicle) {
          result.vehicle_make = vehicle.make;
          result.vehicle_model = vehicle.model;
          result.vehicle_color = vehicle.color;
          result.vehicle_plate = vehicle.plate_number;
        }
      }
    }

    return result;
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
   * Cancel a ride with optional penalty.
   * Returns penalty info if a penalty was applied.
   */
  async cancelRide(
    rideId: string,
    userId?: string,
    reason?: string,
  ): Promise<{ penaltyAmount: number; isBlocked: boolean } | null> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('rides')
      .update({
        status: 'canceled' as RideStatus,
        canceled_at: new Date().toISOString(),
        canceled_by: userId ?? null,
        cancellation_reason: reason ?? null,
      })
      .eq('id', rideId);
    if (error) throw error;

    // Apply cancellation penalty if user is known
    if (userId) {
      try {
        const { data: penaltyData, error: penaltyErr } = await supabase.rpc(
          'apply_cancellation_penalty',
          { p_user_id: userId, p_ride_id: rideId },
        );
        if (!penaltyErr && penaltyData) {
          const row = Array.isArray(penaltyData) ? penaltyData[0] : penaltyData;
          return {
            penaltyAmount: row?.penalty_amount ?? 0,
            isBlocked: row?.is_blocked ?? false,
          };
        }
      } catch {
        // Penalty is non-critical, ride is already canceled
        console.error('Failed to apply cancellation penalty');
      }
    }

    return null;
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
   * Get all rides currently searching for a driver.
   */
  async getSearchingRides(): Promise<Ride[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('rides')
      .select('*')
      .eq('status', 'searching')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as Ride[];
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

  /**
   * Validate a promo code for a ride.
   */
  async validatePromoCode(params: {
    code: string;
    userId: string;
    fareAmount: number;
  }): Promise<{
    valid: boolean;
    promotion?: Promotion;
    discountAmount: number;
    error?: string;
  }> {
    const supabase = getSupabaseClient();

    // Find active promotion by code
    const { data: promo, error } = await supabase
      .from('promotions')
      .select('*')
      .ilike('code', params.code.trim())
      .eq('is_active', true)
      .lte('valid_from', new Date().toISOString())
      .maybeSingle();
    if (error) throw error;
    if (!promo) return { valid: false, discountAmount: 0, error: 'invalid' };

    const promotion = promo as Promotion;

    // Check expiration
    if (promotion.valid_until && new Date(promotion.valid_until) < new Date()) {
      return { valid: false, discountAmount: 0, error: 'expired' };
    }

    // Check max uses
    if (promotion.max_uses !== null && promotion.current_uses >= promotion.max_uses) {
      return { valid: false, discountAmount: 0, error: 'max_uses' };
    }

    // Check if user already used this promo
    const { data: existing } = await supabase
      .from('promotion_uses')
      .select('id')
      .eq('promotion_id', promotion.id)
      .eq('user_id', params.userId)
      .maybeSingle();
    if (existing) {
      return { valid: false, discountAmount: 0, error: 'already_used' };
    }

    // Calculate discount
    let discountAmount = 0;
    if (promotion.type === 'percentage_discount' && promotion.discount_percent) {
      discountAmount = Math.round(params.fareAmount * promotion.discount_percent / 100);
    } else if (promotion.type === 'fixed_discount' && promotion.discount_fixed_cup) {
      discountAmount = Math.min(promotion.discount_fixed_cup, params.fareAmount);
    }
    // bonus_credit: discount is 0, credit applied post-ride

    return { valid: true, promotion, discountAmount };
  },

  /**
   * Subscribe to new ride requests (for drivers).
   * Listens for INSERT (new searching rides) and UPDATE (rides leaving searching status).
   */
  subscribeToNewRides(
    onInsert: (ride: Ride) => void,
    onUpdate: (ride: Ride) => void,
  ) {
    const supabase = getSupabaseClient();
    return supabase
      .channel('rides:searching')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'rides',
          filter: 'status=eq.searching',
        },
        (payload) => {
          onInsert(payload.new as Ride);
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rides',
        },
        (payload) => {
          onUpdate(payload.new as Ride);
        },
      )
      .subscribe();
  },

  // ==================== TIPS ====================

  /**
   * Add a tip to a completed ride (100% to driver, no commission).
   */
  async addTip(rideId: string, fromUserId: string, amount: number): Promise<string> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('add_tip', {
      p_ride_id: rideId,
      p_from_user_id: fromUserId,
      p_amount: amount,
    });
    if (error) throw error;
    return data as string;
  },

  /**
   * Get tips for a ride.
   */
  async getTipsForRide(rideId: string): Promise<Tip[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('tips')
      .select('*')
      .eq('ride_id', rideId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as Tip[];
  },

  // ==================== SURGE ====================

  /**
   * Get active surge multiplier for a zone.
   */
  async getSurgeForZone(zoneId: string): Promise<number> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('calculate_surge', {
      p_zone_id: zoneId,
    });
    if (error) throw error;
    return (data as number) ?? 1.0;
  },

  /**
   * Get all active surge zones.
   */
  async getActiveSurges(): Promise<SurgeZone[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('surge_zones')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as SurgeZone[];
  },
};
