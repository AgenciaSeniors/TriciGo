// ============================================================
// TriciGo — Ride Service
// Ride lifecycle operations.
// ============================================================

import type {
  Ride,
  RideWithDriver,
  RideWithRider,
  RidePricingSnapshot,
  RideTransition,
  FareEstimate,
  ServiceTypeConfig,
  PricingRule,
  Promotion,
  Tip,
  SurgeZone,
  SurgeType,
  TripInsuranceConfig,
  RidePreferences,
  CancellationFeePreview,
} from '@tricigo/types';
import type { PaymentMethod, RideStatus, ServiceTypeSlug } from '@tricigo/types';
import {
  haversineDistance,
  estimateRoadDistance,
  estimateDuration,
  cupToTrcCentavos,
  calculateBaseFare,
  calculateCargoFare,
  applySurge,
  matchPricingRule,
  calculateFareRange,
  maskPhone,
  isLocationInCuba,
} from '@tricigo/utils';
import { getSupabaseClient } from '../client';
import { exchangeRateService } from './exchange-rate.service';
import { corporateService } from './corporate.service';
import { validate, createRideSchema } from '../schemas';

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
  waypoints?: Array<{
    sort_order: number;
    latitude: number;
    longitude: number;
    address: string;
  }>;
  corporate_account_id?: string;
  insurance_selected?: boolean;
  insurance_premium_cup?: number;
  rider_preferences?: RidePreferences;
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

    // Fetch the service config for pricing (default rates)
    const { data: config, error } = await supabase
      .from('service_type_configs')
      .select('*')
      .eq('slug', params.service_type)
      .eq('is_active', true)
      .single();
    if (error) throw error;

    const svcConfig = config as ServiceTypeConfig;

    // Check for time-based pricing rules
    const now = new Date();
    const currentHour = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const currentDay = now.getDay(); // 0=Sun, 6=Sat

    const { data: pricingRules } = await supabase
      .from('pricing_rules')
      .select('*')
      .eq('service_type', params.service_type)
      .eq('is_active', true);

    // Find matching time-based rule (using pure function)
    let baseFare = svcConfig.base_fare_cup;
    let perKmRate = svcConfig.per_km_rate_cup;
    let perMinRate = svcConfig.per_minute_rate_cup;
    let minFare = svcConfig.min_fare_cup;
    let ruleId = svcConfig.id;

    if (pricingRules && pricingRules.length > 0) {
      const matchingRule = matchPricingRule(
        pricingRules as PricingRule[],
        currentHour,
        currentDay,
      );

      if (matchingRule) {
        baseFare = matchingRule.base_fare_cup;
        perKmRate = matchingRule.per_km_rate_cup;
        perMinRate = matchingRule.per_minute_rate_cup;
        minFare = matchingRule.min_fare_cup;
        ruleId = matchingRule.id;
      }
    }

    const pickup = { latitude: params.pickup_lat, longitude: params.pickup_lng };
    const dropoff = { latitude: params.dropoff_lat, longitude: params.dropoff_lng };

    const straightLine = haversineDistance(pickup, dropoff);
    const roadDistance = estimateRoadDistance(straightLine);
    const duration = estimateDuration(roadDistance, params.service_type);

    const distanceKm = roadDistance / 1000;
    const durationMin = duration / 60;

    // Calculate fare using pure function
    const isCargo = params.service_type === 'triciclo_cargo';
    const fareResult = isCargo
      ? calculateCargoFare({
          durationMin: durationMin > 0 ? durationMin : 60, // default 1 hour
          baseFare,
          perMinRate,
          minimumFare: minFare,
        })
      : calculateBaseFare({
          distanceKm,
          durationMin,
          baseFare,
          perKmRate,
          perMinRate,
          minimumFare: minFare,
        });

    // ─── Dynamic Surge ───
    let surgeMultiplier = 1.0;
    let surgeType: SurgeType = 'none';

    try {
      const { data: surgeData } = await supabase.rpc('calculate_dynamic_surge', {
        p_zone_id: null,
        p_lat: params.pickup_lat,
        p_lng: params.pickup_lng,
        p_radius_m: 3000,
      });
      if (typeof surgeData === 'number' && surgeData > 1.0) {
        surgeMultiplier = surgeData;

        // Check if weather surge is active
        const { data: weatherSurge } = await supabase
          .from('surge_zones')
          .select('id')
          .like('reason', 'weather_%')
          .eq('active', true)
          .limit(1);

        const hasWeatherSurge = weatherSurge && weatherSurge.length > 0;
        const hasTimeRule = pricingRules && (pricingRules as PricingRule[]).some(
          (r) => r.time_window_start && r.time_window_end,
        );
        surgeType = hasWeatherSurge ? 'weather' : hasTimeRule ? 'combined' : 'demand';
      }
    } catch {
      console.warn('calculate_dynamic_surge failed, defaulting to 1.0x');
    }

    const surgedFare = applySurge(fareResult.fare, surgeMultiplier);

    // ─── Exchange Rate: convert CUP → TRC ───
    const exchangeRate = await exchangeRateService.getUsdCupRate();
    const estimatedFareTrc = cupToTrcCentavos(surgedFare, exchangeRate);

    // ─── Fare Range (min-max considering traffic variance) ───
    const fareRange = calculateFareRange({
      fareCup: surgedFare,
      surgeMultiplier,
      exchangeRate,
    });

    // ─── Insurance Premium (optional) ───
    let insurancePremiumCup: number | undefined;
    let insurancePremiumTrc: number | undefined;
    let insuranceAvailable = false;
    let insuranceCoverageDesc: string | undefined;

    try {
      const insuranceConfig = await this.getInsuranceConfig(params.service_type);
      if (insuranceConfig) {
        insuranceAvailable = true;
        const premium = this.calculateInsurancePremium(surgedFare, insuranceConfig);
        insurancePremiumCup = premium;
        insurancePremiumTrc = cupToTrcCentavos(premium, exchangeRate);
        insuranceCoverageDesc = insuranceConfig.coverage_description_es;
      }
    } catch {
      // Insurance not available — not critical
    }

    return {
      service_type: params.service_type,
      estimated_fare_cup: surgedFare,
      estimated_fare_trc: estimatedFareTrc,
      estimated_distance_m: Math.round(roadDistance),
      estimated_duration_s: duration,
      surge_multiplier: surgeMultiplier,
      surge_type: surgeType,
      pricing_rule_id: ruleId,
      per_km_rate_cup: perKmRate,
      base_fare_cup: baseFare,
      per_minute_rate_cup: perMinRate,
      min_fare_applied: fareResult.minFareApplied,
      exchange_rate_usd_cup: exchangeRate,
      fare_range_min_cup: fareRange.minFareCup,
      fare_range_max_cup: fareRange.maxFareCup,
      fare_range_min_trc: fareRange.minFareTrc,
      fare_range_max_trc: fareRange.maxFareTrc,
      insurance_premium_cup: insurancePremiumCup,
      insurance_premium_trc: insurancePremiumTrc,
      insurance_available: insuranceAvailable,
      insurance_coverage_desc: insuranceCoverageDesc,
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
    const validParams = validate(createRideSchema, params);

    // Validate coordinates are within Cuba
    if (!isLocationInCuba(validParams.pickup_latitude, validParams.pickup_longitude)) {
      throw new Error('Pickup location is outside the service area');
    }
    if (!isLocationInCuba(validParams.dropoff_latitude, validParams.dropoff_longitude)) {
      throw new Error('Dropoff location is outside the service area');
    }

    const supabase = getSupabaseClient();

    // Get current user for customer_id
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');

    // Snapshot exchange rate at ride creation for consistent pricing
    const exchangeRate = await exchangeRateService.getUsdCupRate();
    const estimatedFareTrc = validParams.estimated_fare_cup
      ? cupToTrcCentavos(validParams.estimated_fare_cup, exchangeRate)
      : 0;

    // Corporate ride validation
    let paymentMethod = validParams.payment_method;
    if (validParams.corporate_account_id) {
      const validation = await corporateService.validateCorporateRide(
        validParams.corporate_account_id,
        user.id,
        estimatedFareTrc,
        validParams.service_type,
      );
      if (!validation.valid) {
        throw new Error(validation.reason ?? 'Corporate ride validation failed');
      }
      paymentMethod = 'corporate';
    }

    const { data, error } = await supabase
      .from('rides')
      .insert({
        customer_id: user.id,
        service_type: validParams.service_type,
        payment_method: paymentMethod,
        pickup_location: `POINT(${validParams.pickup_longitude} ${validParams.pickup_latitude})`,
        pickup_address: validParams.pickup_address,
        dropoff_location: `POINT(${validParams.dropoff_longitude} ${validParams.dropoff_latitude})`,
        dropoff_address: validParams.dropoff_address,
        estimated_fare_cup: validParams.estimated_fare_cup ?? 0,
        estimated_fare_trc: estimatedFareTrc,
        exchange_rate_usd_cup: exchangeRate,
        estimated_distance_m: validParams.estimated_distance_m ?? 0,
        estimated_duration_s: validParams.estimated_duration_s ?? 0,
        scheduled_at: validParams.scheduled_at ?? null,
        is_scheduled: !!validParams.scheduled_at,
        promo_code_id: validParams.promo_code_id ?? null,
        discount_amount_cup: validParams.discount_amount_cup ?? 0,
        corporate_account_id: validParams.corporate_account_id ?? null,
        insurance_selected: validParams.insurance_selected ?? false,
        insurance_premium_cup: validParams.insurance_premium_cup ?? 0,
        rider_preferences: validParams.rider_preferences ?? null,
        status: 'searching' as RideStatus,
      })
      .select()
      .single();
    if (error) throw error;

    // Record promo usage if applicable (both ops must succeed or neither)
    if (validParams.promo_code_id && data) {
      try {
        await supabase.from('promotion_uses').insert({
          promotion_id: validParams.promo_code_id,
          user_id: user.id,
          ride_id: (data as Ride).id,
        });
        await supabase.rpc('increment_promo_uses', {
          p_promo_id: validParams.promo_code_id,
        });
      } catch (promoErr) {
        // Rollback: delete the promotion_use record if increment failed
        try {
          await supabase.from('promotion_uses')
            .delete()
            .eq('ride_id', (data as Ride).id)
            .eq('promotion_id', validParams.promo_code_id);
        } catch { /* best-effort rollback */ }
        console.warn('[Ride] Promo usage recording failed:', promoErr);
      }
    }

    // Insert waypoints if provided
    const rideData = data as Ride;
    if (validParams.waypoints && validParams.waypoints.length > 0) {
      const waypointRows = validParams.waypoints.map((wp) => ({
        ride_id: rideData.id,
        sort_order: wp.sort_order,
        location: `POINT(${wp.longitude} ${wp.latitude})`,
        address: wp.address,
      }));
      await supabase.from('ride_waypoints').insert(waypointRows);
    }

    return rideData;
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
      driver_masked_phone: null,
      driver_total_rides: null,
      vehicle_make: null,
      vehicle_model: null,
      vehicle_color: null,
      vehicle_plate: null,
      vehicle_photo_url: null,
      vehicle_year: null,
    };

    // If driver assigned, fetch details
    if (rideData.driver_id) {
      const { data: driverProfile } = await supabase
        .from('driver_profiles')
        .select('user_id, rating_avg, total_rides_completed')
        .eq('id', rideData.driver_id)
        .single();

      if (driverProfile) {
        result.driver_user_id = driverProfile.user_id;
        result.driver_rating = driverProfile.rating_avg;
        result.driver_total_rides = driverProfile.total_rides_completed ?? null;

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
          result.driver_masked_phone = maskPhone(driverUser.phone);
        }

        // Fetch vehicle
        const { data: vehicle } = await supabase
          .from('vehicles')
          .select('make, model, color, plate_number, photo_url, year')
          .eq('driver_id', rideData.driver_id)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle();

        if (vehicle) {
          result.vehicle_make = vehicle.make;
          result.vehicle_model = vehicle.model;
          result.vehicle_color = vehicle.color;
          result.vehicle_plate = vehicle.plate_number;
          result.vehicle_photo_url = vehicle.photo_url ?? null;
          result.vehicle_year = vehicle.year ?? null;
        }
      }
    }

    // Fetch waypoints
    const { data: waypoints } = await supabase
      .from('ride_waypoints')
      .select('*')
      .eq('ride_id', rideData.id)
      .order('sort_order', { ascending: true });

    if (waypoints && waypoints.length > 0) {
      (result as any).waypoints = waypoints;
    }

    return result;
  },

  /**
   * Get a ride with rider details (for driver display).
   * Joins user info + customer_profiles for name, avatar, and rating.
   */
  async getRideWithRider(rideId: string): Promise<RideWithRider | null> {
    const supabase = getSupabaseClient();

    const { data: ride, error: rideError } = await supabase
      .from('rides')
      .select('*')
      .eq('id', rideId)
      .maybeSingle();
    if (rideError) throw rideError;
    if (!ride) return null;

    const rideData = ride as Ride;

    // Fetch rider (customer) info
    const { data: riderUser } = await supabase
      .from('users')
      .select('full_name, avatar_url')
      .eq('id', rideData.customer_id)
      .single();

    // Fetch customer profile for rating
    const { data: customerProfile } = await supabase
      .from('customer_profiles')
      .select('rating_avg')
      .eq('user_id', rideData.customer_id)
      .maybeSingle();

    return {
      ...rideData,
      rider_name: riderUser?.full_name ?? 'Pasajero',
      rider_avatar_url: riderUser?.avatar_url ?? null,
      rider_rating: customerProfile?.rating_avg ?? 5.0,
    };
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
   * Applies both: (1) state-based cancellation fee and (2) progressive penalty.
   */
  async cancelRide(
    rideId: string,
    userId?: string,
    reason?: string,
  ): Promise<{
    penaltyAmount: number;
    isBlocked: boolean;
    cancellationFee?: CancellationFeePreview;
  } | null> {
    const supabase = getSupabaseClient();

    // Validate that the user is the ride's customer or assigned driver
    if (userId) {
      const { data: ride } = await supabase
        .from('rides')
        .select('customer_id, driver_id')
        .eq('id', rideId)
        .single();

      if (ride) {
        // Check driver: driver_profiles.id → driver_profiles.user_id
        let isDriverUser = false;
        if (ride.driver_id) {
          const { data: dp } = await supabase
            .from('driver_profiles')
            .select('user_id')
            .eq('id', ride.driver_id)
            .single();
          isDriverUser = dp?.user_id === userId;
        }

        if (ride.customer_id !== userId && !isDriverUser) {
          throw new Error('Unauthorized: user is not the customer or driver of this ride');
        }
      }
    }

    // 1. Update ride status FIRST (critical — must succeed before applying fees)
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

    // 2. Apply state-based cancellation fee (non-critical — ride is already canceled)
    let cancellationFee: CancellationFeePreview | undefined;
    if (userId) {
      try {
        const { data: feeData, error: feeErr } = await supabase.rpc(
          'apply_cancellation_fee',
          { p_ride_id: rideId, p_canceled_by: userId },
        );
        if (!feeErr && feeData) {
          const row = Array.isArray(feeData) ? feeData[0] : feeData;
          cancellationFee = {
            fee_cup: row?.fee_cup ?? 0,
            fee_trc: row?.fee_trc ?? 0,
            fee_reason: row?.fee_reason ?? 'free_cancel',
            is_free: (row?.fee_cup ?? 0) === 0,
          };
        }
      } catch {
        console.error('Failed to apply cancellation fee');
      }
    }

    // 3. Apply progressive cancellation penalty (non-critical)
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
            cancellationFee,
          };
        }
      } catch {
        console.error('Failed to apply cancellation penalty');
      }
    }

    return cancellationFee ? { penaltyAmount: 0, isBlocked: false, cancellationFee } : null;
  },

  /**
   * Preview the cancellation fee based on ride state (without applying it).
   * Shows the user exactly what they'd be charged before confirming.
   */
  async previewCancellationFee(
    rideId: string,
    userId: string,
  ): Promise<CancellationFeePreview> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('calculate_cancellation_fee', {
      p_ride_id: rideId,
      p_canceled_by: userId,
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    return {
      fee_cup: row?.fee_cup ?? 0,
      fee_trc: row?.fee_trc ?? 0,
      fee_reason: row?.fee_reason ?? 'free_cancel',
      is_free: row?.is_free ?? true,
    };
  },

  /**
   * Preview the cancellation penalty that would be applied (without applying it).
   * Used to show the user what penalty they'd face before confirming cancellation.
   */
  async previewCancelPenalty(userId: string): Promise<{
    penaltyAmount: number;
    isBlocked: boolean;
    cancelCount24h: number;
  }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('preview_cancellation_penalty', {
      p_user_id: userId,
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    return {
      penaltyAmount: row?.penalty_amount ?? 0,
      isBlocked: row?.is_blocked ?? false,
      cancelCount24h: row?.cancel_count_24h ?? 0,
    };
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
   * Get ride history with optional filters.
   */
  async getRideHistoryFiltered(params: {
    userId: string;
    page?: number;
    pageSize?: number;
    status?: ('completed' | 'canceled')[];
    serviceType?: ServiceTypeSlug;
    paymentMethod?: PaymentMethod;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<Ride[]> {
    const supabase = getSupabaseClient();
    const page = params.page ?? 0;
    const pageSize = params.pageSize ?? 20;
    const from = page * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
      .from('rides')
      .select('*')
      .eq('customer_id', params.userId);

    // Status filter
    const statuses = params.status ?? ['completed', 'canceled'];
    query = query.in('status', statuses);

    // Service type filter
    if (params.serviceType) {
      query = query.eq('service_type', params.serviceType);
    }

    // Payment method filter
    if (params.paymentMethod) {
      query = query.eq('payment_method', params.paymentMethod);
    }

    // Date range filters
    if (params.dateFrom) {
      query = query.gte('created_at', params.dateFrom);
    }
    if (params.dateTo) {
      query = query.lte('created_at', params.dateTo);
    }

    const { data, error } = await query
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
      discountAmount = Math.min(
        Math.round(params.fareAmount * promotion.discount_percent / 100),
        params.fareAmount, // Cap at 100% of fare
      );
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

  // ==================== PUBLIC / SHARE TOKEN ====================

  /**
   * Get a ride by its public share token (no auth required).
   */
  async getRideByShareToken(token: string): Promise<RideWithDriver | null> {
    const supabase = getSupabaseClient();
    const { data: ride, error } = await supabase
      .from('rides')
      .select('*')
      .eq('share_token', token)
      .maybeSingle();
    if (error) throw error;
    if (!ride) return null;

    // Reuse getRideWithDriver logic for driver details
    return this.getRideWithDriver((ride as Ride).id);
  },

  /**
   * Get the share_token for a ride (used for live trip sharing).
   */
  async getShareTokenForRide(rideId: string): Promise<string | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('rides')
      .select('share_token')
      .eq('id', rideId)
      .single();
    if (error) throw error;
    return data?.share_token ?? null;
  },

  /**
   * Generate a share_token for a ride that doesn't have one yet.
   * Fallback for rides accepted before the trigger migration.
   */
  async generateShareToken(rideId: string): Promise<string> {
    // Generate 24-char hex token (same format as DB trigger)
    const chars = '0123456789abcdef';
    let token = '';
    for (let i = 0; i < 24; i++) {
      token += chars[Math.floor(Math.random() * 16)];
    }
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('rides')
      .update({ share_token: token })
      .eq('id', rideId)
      .is('share_token', null);
    if (error) throw error;
    return token;
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

  /**
   * Assign a chained (next) ride to a driver currently on a ride.
   */
  async assignChainedRide(currentRideId: string, nextRideId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('rides')
      .update({ next_ride_id: nextRideId })
      .eq('id', currentRideId);
    if (error) throw error;

    // Mark the next ride as chained
    await supabase
      .from('rides')
      .update({ is_chained: true })
      .eq('id', nextRideId);
  },

  /**
   * Add a waypoint to an active ride (max 3 waypoints).
   */
  async addWaypointToActiveRide(
    rideId: string,
    address: string,
    latitude: number,
    longitude: number,
  ): Promise<any> {
    const supabase = getSupabaseClient();
    // Get current max sort_order
    const { data: existing } = await supabase
      .from('ride_waypoints')
      .select('sort_order')
      .eq('ride_id', rideId)
      .order('sort_order', { ascending: false })
      .limit(1);
    const nextOrder = (existing?.[0]?.sort_order ?? 0) + 1;
    if (nextOrder > 3) throw new Error('MAX_WAYPOINTS_REACHED');
    const { data, error } = await supabase
      .from('ride_waypoints')
      .insert({
        ride_id: rideId,
        address,
        location: `POINT(${longitude} ${latitude})`,
        sort_order: nextOrder,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Get waypoints for a ride.
   */
  async getRideWaypoints(rideId: string): Promise<any[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_waypoints')
      .select('*')
      .eq('ride_id', rideId)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return data ?? [];
  },

  /**
   * Mark a waypoint as arrived (driver reached the stop).
   */
  async arriveAtWaypoint(waypointId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('ride_waypoints')
      .update({ arrived_at: new Date().toISOString() })
      .eq('id', waypointId)
      .is('arrived_at', null);
    if (error) throw error;
  },

  /**
   * Mark a waypoint as departed (driver left the stop, continuing to next).
   */
  async departFromWaypoint(waypointId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('ride_waypoints')
      .update({ departed_at: new Date().toISOString() })
      .eq('id', waypointId)
      .is('departed_at', null);
    if (error) throw error;
  },

  /**
   * Subscribe to waypoint changes (INSERT + UPDATE) for a ride.
   * Used by rider to see when driver arrives/departs stops.
   */
  subscribeToWaypoints(
    rideId: string,
    onInsert: (wp: any) => void,
    onUpdate: (wp: any) => void,
  ) {
    const supabase = getSupabaseClient();
    return supabase
      .channel(`waypoints-${rideId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'ride_waypoints',
          filter: `ride_id=eq.${rideId}`,
        },
        (payload) => onInsert(payload.new),
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'ride_waypoints',
          filter: `ride_id=eq.${rideId}`,
        },
        (payload) => onUpdate(payload.new),
      )
      .subscribe();
  },

  // ============================================================
  // Fare Splitting
  // ============================================================

  /**
   * Invite a user to split the fare for a ride.
   * Only works for tricicoin payment method.
   */
  async createSplitInvite(
    rideId: string,
    invitedUserId: string,
    invitedByUserId: string,
    sharePct: number,
  ): Promise<any> {
    const supabase = getSupabaseClient();

    // Validate payment method is tricicoin
    const { data: ride } = await supabase
      .from('rides')
      .select('payment_method, is_split')
      .eq('id', rideId)
      .single();
    if (ride?.payment_method !== 'tricicoin') {
      throw new Error('SPLIT_ONLY_TRICICOIN');
    }

    // Mark ride as split if not already
    if (!ride.is_split) {
      await supabase.from('rides').update({ is_split: true }).eq('id', rideId);
    }

    const { data, error } = await supabase
      .from('ride_splits')
      .insert({
        ride_id: rideId,
        user_id: invitedUserId,
        invited_by: invitedByUserId,
        share_pct: sharePct,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Remove a split invite (before ride starts).
   */
  async removeSplitInvite(rideId: string, splitId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('ride_splits')
      .delete()
      .eq('id', splitId)
      .eq('ride_id', rideId);
    if (error) throw error;

    // Check if there are remaining splits
    const { data: remaining } = await supabase
      .from('ride_splits')
      .select('id')
      .eq('ride_id', rideId);
    if (!remaining || remaining.length === 0) {
      await supabase.from('rides').update({ is_split: false }).eq('id', rideId);
    }
  },

  /**
   * Accept a split invite (invited user accepts their share).
   */
  async acceptSplitInvite(splitId: string, userId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('ride_splits')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', splitId)
      .eq('user_id', userId)
      .is('accepted_at', null);
    if (error) throw error;
  },

  /**
   * Get all splits for a ride with user info.
   */
  async getSplitsForRide(rideId: string): Promise<any[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_splits')
      .select('*, users:user_id(raw_user_meta_data)')
      .eq('ride_id', rideId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map((s: any) => ({
      ...s,
      user_name: s.users?.raw_user_meta_data?.name ?? null,
      user_phone: s.users?.raw_user_meta_data?.phone ?? null,
      users: undefined,
    }));
  },

  /**
   * Get pending split invites for a user.
   */
  async getMySplitInvites(userId: string): Promise<any[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_splits')
      .select('*, rides!inner(status, pickup_address, dropoff_address, estimated_fare_trc)')
      .eq('user_id', userId)
      .eq('payment_status', 'pending')
      .is('accepted_at', null)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  },

  // ============================================================
  // Trip Insurance
  // ============================================================

  /**
   * Get the active insurance config for a service type.
   */
  async getInsuranceConfig(serviceType: ServiceTypeSlug): Promise<TripInsuranceConfig | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('trip_insurance_configs')
      .select('*')
      .eq('service_type', serviceType)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw error;
    return data as TripInsuranceConfig | null;
  },

  /**
   * Calculate the insurance premium in CUP for a given fare.
   * Returns the premium amount (>= min_premium_cup from config).
   */
  calculateInsurancePremium(
    estimatedFareCup: number,
    config: TripInsuranceConfig,
  ): number {
    const rawPremium = Math.round(estimatedFareCup * config.premium_pct);
    return Math.max(rawPremium, config.min_premium_cup);
  },

  /**
   * Subscribe to split changes for a ride.
   */
  subscribeToSplits(
    rideId: string,
    onInsert: (split: any) => void,
    onUpdate: (split: any) => void,
  ) {
    const supabase = getSupabaseClient();
    return supabase
      .channel(`splits-${rideId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ride_splits', filter: `ride_id=eq.${rideId}` },
        (payload) => onInsert(payload.new),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'ride_splits', filter: `ride_id=eq.${rideId}` },
        (payload) => onUpdate(payload.new),
      )
      .subscribe();
  },
};
