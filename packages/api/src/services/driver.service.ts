// ============================================================
// TriciGo — Driver Service
// Driver-specific operations: onboarding, status, trips.
// ============================================================

import type {
  DriverProfile,
  DriverDocument,
  CancellationPenalty,
  Vehicle,
  Ride,
  CompleteRideResult,
} from '@tricigo/types';
import type { DriverStatus, RideStatus } from '@tricigo/types';
import { cupToTrcCentavos } from '@tricigo/utils';
import { getSupabaseClient } from '../client';
import { exchangeRateService } from './exchange-rate.service';

export const driverService = {
  /**
   * Get the driver profile for the current user.
   */
  async getProfile(userId: string): Promise<DriverProfile | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    return data as DriverProfile | null;
  },

  /**
   * Create initial driver profile (start onboarding).
   */
  async createProfile(userId: string): Promise<DriverProfile> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_profiles')
      .insert({
        user_id: userId,
        status: 'pending_verification' as DriverStatus,
        is_online: false,
        rating_avg: 5.0,
        total_rides: 0,
        total_rides_completed: 0,
      })
      .select()
      .single();
    if (error) throw error;
    return data as DriverProfile;
  },

  /**
   * Upload a verification document.
   */
  async uploadDocument(
    driverId: string,
    documentType: string,
    filePath: string,
    fileName: string,
  ): Promise<DriverDocument> {
    const supabase = getSupabaseClient();

    // Upload file to Supabase Storage
    const storagePath = `driver-docs/${driverId}/${documentType}/${fileName}`;
    const response = await fetch(filePath);
    const blob = await response.blob();

    const { error: uploadError } = await supabase.storage
      .from('driver-documents')
      .upload(storagePath, blob);
    if (uploadError) throw uploadError;

    // Create document record
    const { data, error } = await supabase
      .from('driver_documents')
      .insert({
        driver_id: driverId,
        document_type: documentType,
        storage_path: storagePath,
        file_name: fileName,
      })
      .select()
      .single();
    if (error) throw error;
    return data as DriverDocument;
  },

  /**
   * Get all documents for a driver.
   */
  async getDocuments(driverId: string): Promise<DriverDocument[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_documents')
      .select('*')
      .eq('driver_id', driverId)
      .order('uploaded_at', { ascending: false });
    if (error) throw error;
    return data as DriverDocument[];
  },

  /**
   * Get the active vehicle for a driver.
   */
  async getVehicle(driverId: string): Promise<Vehicle | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('vehicles')
      .select('*')
      .eq('driver_id', driverId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as Vehicle | null;
  },

  /**
   * Register a vehicle for the driver.
   */
  async registerVehicle(vehicle: Omit<Vehicle, 'id' | 'created_at' | 'updated_at'>): Promise<Vehicle> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('vehicles')
      .insert(vehicle)
      .select()
      .single();
    if (error) throw error;
    return data as Vehicle;
  },

  /**
   * Submit driver profile for verification.
   */
  async submitForVerification(driverId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('driver_profiles')
      .update({ status: 'under_review' as DriverStatus })
      .eq('id', driverId);
    if (error) throw error;
  },

  /**
   * Toggle online/offline status.
   */
  async setOnlineStatus(
    driverId: string,
    isOnline: boolean,
    location?: { latitude: number; longitude: number },
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const updates: Record<string, unknown> = { is_online: isOnline };
    if (location) {
      updates.current_location = `POINT(${location.longitude} ${location.latitude})`;
    }
    const { error } = await supabase
      .from('driver_profiles')
      .update(updates)
      .eq('id', driverId);
    if (error) throw error;
  },

  /**
   * Update driver location.
   */
  async updateLocation(
    driverId: string,
    latitude: number,
    longitude: number,
    heading?: number,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('driver_profiles')
      .update({
        current_location: `POINT(${longitude} ${latitude})`,
        current_heading: heading ?? null,
      })
      .eq('id', driverId);
    if (error) throw error;
  },

  /**
   * Accept a ride request.
   * Snapshots the driver's custom per-km rate and recalculates the fare
   * using the driver's rate (or platform default if not set).
   */
  async acceptRide(rideId: string, driverId: string): Promise<Ride> {
    const supabase = getSupabaseClient();

    // 1. Fetch the driver's custom rate
    const { data: driverProfile, error: dpErr } = await supabase
      .from('driver_profiles')
      .select('custom_per_km_rate_cup')
      .eq('id', driverId)
      .single();
    if (dpErr) throw dpErr;

    const driverCustomRate: number | null = driverProfile?.custom_per_km_rate_cup ?? null;

    // 2. Fetch the ride to get service_type, distance, duration, exchange_rate
    const { data: rideData, error: rideErr } = await supabase
      .from('rides')
      .select('*')
      .eq('id', rideId)
      .eq('status', 'searching')
      .single();
    if (rideErr) throw rideErr;
    const ride = rideData as Ride;

    // 3. Fetch service config for base_fare, per_km_rate (fallback), per_minute_rate, min_fare
    const { data: svcConfig, error: svcErr } = await supabase
      .from('service_type_configs')
      .select('base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup')
      .eq('slug', ride.service_type)
      .eq('is_active', true)
      .single();
    if (svcErr) throw svcErr;

    // 4. Recalculate fare using driver's rate (or platform default)
    const effectivePerKmRate = driverCustomRate ?? svcConfig.per_km_rate_cup;
    const distanceKm = ride.estimated_distance_m / 1000;
    const durationMin = ride.estimated_duration_s / 60;

    const rawFare = Math.round(
      svcConfig.base_fare_cup +
      distanceKm * effectivePerKmRate +
      durationMin * svcConfig.per_minute_rate_cup,
    );
    const baseFare = Math.max(rawFare, svcConfig.min_fare_cup);

    // Apply surge multiplier
    const surgeMultiplier = ride.surge_multiplier ?? 1.0;
    const fareAfterSurge = Math.round(baseFare * surgeMultiplier);

    // Apply discount
    const discount = ride.discount_amount_cup ?? 0;
    const estimatedFareCup = Math.max(fareAfterSurge - discount, 0);

    // Convert CUP to TRC
    const exchangeRate = ride.exchange_rate_usd_cup
      ?? await exchangeRateService.getUsdCupRate();
    const estimatedFareTrc = cupToTrcCentavos(estimatedFareCup, exchangeRate);

    // 5. Update ride atomically with driver rate + recalculated fare
    const { data, error } = await supabase
      .from('rides')
      .update({
        driver_id: driverId,
        status: 'accepted' as RideStatus,
        accepted_at: new Date().toISOString(),
        driver_custom_rate_cup: driverCustomRate,
        estimated_fare_cup: estimatedFareCup,
        estimated_fare_trc: estimatedFareTrc,
      })
      .eq('id', rideId)
      .eq('status', 'searching')
      .select()
      .single();
    if (error) throw error;
    return data as Ride;
  },

  /**
   * Update ride status (driver-side transitions).
   * For completion, use completeRide() instead.
   */
  async updateRideStatus(
    rideId: string,
    status: RideStatus,
  ): Promise<void> {
    if (status === 'completed') {
      throw new Error('Use completeRide() for ride completion');
    }

    const supabase = getSupabaseClient();
    const updates: Record<string, unknown> = { status };

    switch (status) {
      case 'arrived_at_pickup':
        updates.driver_arrived_at = new Date().toISOString();
        break;
      case 'in_progress':
        updates.pickup_at = new Date().toISOString();
        break;
    }

    const { error } = await supabase
      .from('rides')
      .update(updates)
      .eq('id', rideId);
    if (error) throw error;
  },

  /**
   * Complete a ride with final fare calculation and payment processing.
   * Calls complete_ride_and_pay PL/pgSQL function atomically.
   */
  async completeRide(params: {
    rideId: string;
    driverId: string;
    actualDistanceM: number;
    actualDurationS: number;
  }): Promise<CompleteRideResult> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('complete_ride_and_pay', {
      p_ride_id: params.rideId,
      p_driver_id: params.driverId,
      p_actual_distance_m: params.actualDistanceM,
      p_actual_duration_s: params.actualDurationS,
    });
    if (error) throw error;
    return data as CompleteRideResult;
  },

  /**
   * Get the active trip for the driver.
   */
  async getActiveTrip(driverId: string): Promise<Ride | null> {
    const supabase = getSupabaseClient();
    const activeStatuses: RideStatus[] = [
      'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress',
    ];

    const { data, error } = await supabase
      .from('rides')
      .select('*')
      .eq('driver_id', driverId)
      .in('status', activeStatuses)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as Ride | null;
  },

  /**
   * Get trip history for the driver.
   */
  async getTripHistory(
    driverId: string,
    page = 0,
    pageSize = 20,
  ): Promise<Ride[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('rides')
      .select('*')
      .eq('driver_id', driverId)
      .in('status', ['completed', 'canceled'])
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data as Ride[];
  },

  // ==================== ELIGIBILITY ====================

  /**
   * Check and update driver financial eligibility.
   */
  async checkEligibility(driverId: string): Promise<boolean> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('check_driver_eligibility', {
      p_driver_id: driverId,
    });
    if (error) throw error;
    return data as boolean;
  },

  /**
   * Get eligibility status for the driver.
   */
  async getEligibilityStatus(driverId: string): Promise<{
    is_eligible: boolean;
    negative_since: string | null;
  }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_profiles')
      .select('is_financially_eligible, negative_balance_since')
      .eq('id', driverId)
      .single();
    if (error) throw error;
    return {
      is_eligible: data?.is_financially_eligible ?? true,
      negative_since: data?.negative_balance_since ?? null,
    };
  },

  /**
   * Accept a ride with eligibility check.
   */
  async acceptRideWithEligibility(rideId: string, driverId: string): Promise<Ride> {
    const supabase = getSupabaseClient();

    // Check eligibility first
    const { data: eligible } = await supabase.rpc('check_accept_ride_eligibility', {
      p_driver_id: driverId,
    });

    if (!eligible) {
      throw new Error('No puedes aceptar viajes: tu cuenta tiene un saldo negativo pendiente.');
    }

    return this.acceptRide(rideId, driverId);
  },

  // ==================== CUSTOM PRICING ====================

  /**
   * Get the driver's custom rate configuration.
   * Returns current rate in CUP, default rate, max multiplier, and exchange rate.
   */
  async getCustomRateConfig(driverId: string): Promise<{
    currentRate: number | null;
    defaultRate: number;
    maxMultiplier: number;
    exchangeRate: number;
  }> {
    const supabase = getSupabaseClient();

    // Fetch driver's custom rate
    const { data: profile, error: profileErr } = await supabase
      .from('driver_profiles')
      .select('custom_per_km_rate_cup')
      .eq('id', driverId)
      .single();
    if (profileErr) throw profileErr;

    // Fetch platform config for defaults
    const { data: configs, error: configErr } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', ['default_per_km_rate_cup', 'max_driver_rate_multiplier']);
    if (configErr) throw configErr;

    const configMap = Object.fromEntries(
      (configs ?? []).map((c: { key: string; value: string }) => [c.key, c.value]),
    );

    // Fetch current exchange rate
    let exchangeRate = 520;
    try {
      const { data: rateRow } = await supabase
        .from('exchange_rates')
        .select('usd_cup_rate')
        .eq('is_current', true)
        .single();
      if (rateRow) exchangeRate = Number(rateRow.usd_cup_rate);
    } catch { /* fallback */ }

    return {
      currentRate: profile?.custom_per_km_rate_cup ?? null,
      defaultRate: Number(configMap.default_per_km_rate_cup ?? '150'),
      maxMultiplier: Number(configMap.max_driver_rate_multiplier ?? '2.0'),
      exchangeRate,
    };
  },

  /**
   * Update the driver's custom per-km rate (in CUP whole pesos).
   * Validates against platform limits before saving.
   */
  async updateCustomRate(
    driverId: string,
    customPerKmRate: number | null,
  ): Promise<void> {
    const supabase = getSupabaseClient();

    // If setting a custom rate, validate against platform limits
    if (customPerKmRate !== null) {
      const config = await this.getCustomRateConfig(driverId);
      const maxRate = Math.round(config.defaultRate * config.maxMultiplier);

      if (customPerKmRate < config.defaultRate) {
        throw new Error('Rate cannot be below the minimum default rate');
      }
      if (customPerKmRate > maxRate) {
        throw new Error(`Rate cannot exceed ${maxRate} (${config.maxMultiplier}x default)`);
      }
    }

    const { error } = await supabase
      .from('driver_profiles')
      .update({ custom_per_km_rate_cup: customPerKmRate })
      .eq('id', driverId);
    if (error) throw error;
  },

  /**
   * Get cancellation penalties for a user.
   */
  async getCancellationPenalties(
    userId: string,
    limit = 10,
  ): Promise<CancellationPenalty[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('cancellation_penalties')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data as CancellationPenalty[];
  },
};
