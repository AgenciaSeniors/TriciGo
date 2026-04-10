// ============================================================
// TriciGo — Driver Service
// Driver-specific operations: onboarding, status, trips.
// ============================================================

import type {
  DriverProfile,
  DriverDocument,
  CancellationPenalty,
  Vehicle,
  VehicleType,
  PackageCategory,
  Ride,
  CompleteRideResult,
  ServiceTypeSlug,
  PaymentMethod,
  SelfieCheck,
} from '@tricigo/types';
import type { DriverStatus, RideStatus } from '@tricigo/types';
import { cupToTrcCentavos, logger } from '@tricigo/utils';
import { getSupabaseClient } from '../client';
import { exchangeRateService } from './exchange-rate.service';
import { notificationService } from './notification.service';

/**
 * Transform raw Supabase ride data to proper GeoPoint coordinates.
 * PostGIS returns pickup_location/dropoff_location as WKB hex strings,
 * but the Ride type expects { latitude, longitude } GeoPoint objects.
 * We use the auto-synced pickup_lat/lng and dropoff_lat/lng columns instead.
 */
function transformRideCoordinates(ride: Record<string, unknown>): Ride {
  return {
    ...(ride as unknown as Ride),
    pickup_location: { latitude: (ride.pickup_lat as number) ?? 0, longitude: (ride.pickup_lng as number) ?? 0 },
    dropoff_location: { latitude: (ride.dropoff_lat as number) ?? 0, longitude: (ride.dropoff_lng as number) ?? 0 },
  };
}

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
   * Update vehicle cargo/delivery settings.
   */
  async updateVehicleCargo(vehicleId: string, updates: {
    accepts_cargo: boolean;
    max_cargo_weight_kg?: number | null;
    max_cargo_length_cm?: number | null;
    max_cargo_width_cm?: number | null;
    max_cargo_height_cm?: number | null;
    accepted_cargo_categories?: PackageCategory[];
  }): Promise<Vehicle> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('vehicles')
      .update(updates)
      .eq('id', vehicleId)
      .select()
      .single();
    if (error) throw error;
    return data as Vehicle;
  },

  /**
   * Update vehicle details (type, make, model, year, color, plate, capacity, photo).
   */
  async updateVehicle(vehicleId: string, updates: {
    type?: VehicleType;
    make?: string;
    model?: string;
    year?: number;
    color?: string;
    plate_number?: string;
    capacity?: number;
    photo_url?: string | null;
  }): Promise<Vehicle> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('vehicles')
      .update(updates)
      .eq('id', vehicleId)
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
   * Update driver personal information (identity, address, province, municipality, criminal record).
   * Called during onboarding to save extended personal data.
   */
  async updatePersonalInfo(
    driverId: string,
    info: {
      identity_number?: string;
      address?: string;
      province?: string;
      municipality?: string;
      has_criminal_record?: boolean;
      criminal_record_details?: string;
    },
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('driver_profiles')
      .update(info)
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

    // 5. Atomic accept via RPC (handles locking, idempotency, heartbeat, active-ride check)
    const { data: result, error: rpcError } = await supabase.rpc('accept_ride', {
      p_ride_id: rideId,
      p_driver_id: driverId,
    });

    if (rpcError) throw rpcError;

    logger.info('[Accept] RPC result', {
      ride_id: rideId,
      result: result?.success ? 'ok' : result?.error,
      idempotent: result?.idempotent || false,
    });

    if (result?.error) {
      if (result.error === 'ride_already_taken' || result.error === 'ride_not_found') {
        throw new Error(result.error);
      }
      if (result.idempotent) {
        // Same driver already accepted this ride — treat as success
        logger.info('[Accept] Idempotent success', { ride_id: rideId });
      } else {
        throw new Error(result.error);
      }
    }

    // 6. Update fare data (non-critical follow-up after atomic accept)
    if (result?.success) {
      await supabase.from('rides').update({
        estimated_fare_cup: estimatedFareCup,
        estimated_fare_trc: estimatedFareTrc,
        driver_custom_rate_cup: driverCustomRate,
      }).eq('id', rideId);
    }

    // 7. Return the updated ride
    const { data: updatedRide, error: fetchErr } = await supabase
      .from('rides')
      .select('*')
      .eq('id', rideId)
      .single();
    if (fetchErr) throw fetchErr;

    const acceptedRide = updatedRide as Ride;

    // 8. Notify customer — delivery-specific message
    if (acceptedRide.ride_mode === 'cargo') {
      notificationService.notifyUser(
        acceptedRide.customer_id,
        'Conductor asignado a tu envío',
        'Un conductor va en camino a recoger tu paquete',
        { ride_id: rideId, type: 'delivery_accepted' },
      ).catch(() => { /* non-blocking */ });
    }

    return acceptedRide;
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
      case 'arrived_at_destination':
        updates.arrived_at_destination_at = new Date().toISOString();
        break;
    }

    const { error } = await supabase
      .from('rides')
      .update(updates)
      .eq('id', rideId);
    if (error) throw new Error(error.message || JSON.stringify(error));

    // Delivery-specific notifications
    const { data: rideData } = await supabase
      .from('rides')
      .select('customer_id, ride_mode')
      .eq('id', rideId)
      .single();
    if (rideData?.ride_mode === 'cargo') {
      const msgs: Record<string, { title: string; body: string }> = {
        arrived_at_pickup: { title: 'Conductor en punto de recogida', body: 'El conductor llego al punto de recogida de tu paquete' },
        in_progress: { title: 'Tu paquete esta en camino', body: 'El conductor recogio tu paquete y va en camino al destino' },
      };
      const msg = msgs[status];
      if (msg) {
        notificationService.notifyUser(
          rideData.customer_id,
          msg.title,
          msg.body,
          { ride_id: rideId, type: `delivery_${status}` },
        ).catch(() => { /* non-blocking */ });
      }
    }
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
    if (error) throw new Error(error.message || JSON.stringify(error));
    return data as CompleteRideResult;
  },

  /**
   * Get the active trip for the driver.
   */
  async getActiveTrip(driverId: string): Promise<Ride | null> {
    const supabase = getSupabaseClient();
    const activeStatuses: RideStatus[] = [
      'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination',
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
    if (!data) return null;
    return transformRideCoordinates(data as Record<string, unknown>);
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
    return (data ?? []).map((r) => transformRideCoordinates(r as Record<string, unknown>));
  },

  /**
   * Get completed trip history for a driver within a date range.
   */
  async getTripHistoryByDateRange(
    driverId: string,
    startDate: string,
    endDate: string,
  ): Promise<Ride[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('rides')
      .select('id, status, created_at, completed_at, final_fare_cup, estimated_fare_cup, final_fare_trc, actual_distance_m, actual_duration_s, service_type, payment_method, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng')
      .eq('driver_id', driverId)
      .eq('status', 'completed')
      .gte('completed_at', startDate)
      .lte('completed_at', endDate)
      .order('completed_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return (data ?? []).map((r) => transformRideCoordinates(r as Record<string, unknown>));
  },

  /**
   * Get filtered trip history for the driver.
   */
  async getTripHistoryFiltered(params: {
    driverId: string;
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
      .eq('driver_id', params.driverId);

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
    return (data ?? []).map((r) => transformRideCoordinates(r as Record<string, unknown>));
  },

  // ==================== AUTO-ACCEPT ====================

  /**
   * Enable or disable auto-accept for incoming rides.
   */
  async setAutoAccept(driverId: string, enabled: boolean): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('driver_profiles')
      .update({ auto_accept_enabled: enabled })
      .eq('id', driverId);
    if (error) throw error;
  },

  /**
   * Check if a driver is eligible for auto-accept (>=50 rides, >=4.5 rating).
   */
  async isEligibleForAutoAccept(driverId: string): Promise<boolean> {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('driver_profiles')
      .select('total_rides, rating_avg')
      .eq('id', driverId)
      .single();
    if (!data) return false;
    return (data.total_rides ?? 0) >= 50 && (data.rating_avg ?? 0) >= 4.5;
  },

  // ==================== BREAK MODE ====================

  /**
   * Set break status for a driver.
   * A driver on break stays "online" but won't receive ride requests.
   */
  async setBreakStatus(driverId: string, isOnBreak: boolean): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('driver_profiles')
      .update({ is_on_break: isOnBreak })
      .eq('id', driverId);
    if (error) throw error;
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
    let exchangeRate = 510;
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

  /**
   * Get driver performance stats: acceptance, completion, cancellation rates,
   * weekly/monthly ride counts, avg response time, rating, and match score.
   */
  async getDriverStats(driverId: string): Promise<{
    acceptanceRate: number;
    cancellationRate: number;
    completionRate: number;
    totalRidesOffered: number;
    totalRidesCompleted: number;
    totalRidesCanceled: number;
    ridesThisWeek: number;
    ridesThisMonth: number;
    avgResponseTimeS: number | null;
    ratingAvg: number;
    matchScore: number;
  }> {
    const supabase = getSupabaseClient();

    // 1. Driver profile basic stats
    const { data: profile, error: profileErr } = await supabase
      .from('driver_profiles')
      .select('acceptance_rate, total_rides_offered, total_rides, total_rides_completed, rating_avg, match_score')
      .eq('id', driverId)
      .single();
    if (profileErr) throw profileErr;

    // 2. Rides canceled by this driver
    const { count: canceledCount } = await supabase
      .from('rides')
      .select('id', { count: 'exact', head: true })
      .eq('driver_id', driverId)
      .eq('status', 'canceled');

    // 3. Rides completed this week (Monday-based)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
    monday.setHours(0, 0, 0, 0);

    const { count: weekCount } = await supabase
      .from('rides')
      .select('id', { count: 'exact', head: true })
      .eq('driver_id', driverId)
      .eq('status', 'completed')
      .gte('completed_at', monday.toISOString());

    // 4. Rides completed this month
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const { count: monthCount } = await supabase
      .from('rides')
      .select('id', { count: 'exact', head: true })
      .eq('driver_id', driverId)
      .eq('status', 'completed')
      .gte('completed_at', monthStart.toISOString());

    // 5. Average response time (time from ride creation to acceptance)
    let avgResponseTimeS: number | null = null;
    try {
      const { data: recentRides } = await supabase
        .from('rides')
        .select('created_at, accepted_at')
        .eq('driver_id', driverId)
        .not('accepted_at', 'is', null)
        .order('accepted_at', { ascending: false })
        .limit(50);

      if (recentRides && recentRides.length > 0) {
        const totalSeconds = recentRides.reduce((sum: number, r: { created_at: string; accepted_at: string }) => {
          const diff = (new Date(r.accepted_at).getTime() - new Date(r.created_at).getTime()) / 1000;
          return sum + Math.max(diff, 0);
        }, 0);
        avgResponseTimeS = Math.round(totalSeconds / recentRides.length);
      }
    } catch { /* non-critical */ }

    const totalOffered = profile.total_rides_offered || 1;
    const totalCanceled = canceledCount ?? 0;
    const totalCompleted = profile.total_rides_completed ?? 0;

    return {
      acceptanceRate: profile.acceptance_rate ?? 0,
      cancellationRate: totalOffered > 0 ? totalCanceled / totalOffered : 0,
      completionRate: totalOffered > 0 ? totalCompleted / totalOffered : 0,
      totalRidesOffered: profile.total_rides_offered ?? 0,
      totalRidesCompleted: totalCompleted,
      totalRidesCanceled: totalCanceled,
      ridesThisWeek: weekCount ?? 0,
      ridesThisMonth: monthCount ?? 0,
      avgResponseTimeS,
      ratingAvg: profile.rating_avg ?? 5.0,
      matchScore: profile.match_score ?? 50,
    };
  },

  // ==================== IDENTITY VERIFICATION ====================

  /**
   * Get verification status for all documents of a driver.
   */
  async getDocumentVerificationStatus(
    driverId: string,
  ): Promise<DriverDocument[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_documents')
      .select('*')
      .eq('driver_id', driverId)
      .order('uploaded_at', { ascending: true });
    if (error) throw error;
    return data as DriverDocument[];
  },

  /**
   * Request a periodic selfie check for a driver.
   */
  async requestSelfieCheck(driverId: string): Promise<SelfieCheck> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('selfie_checks')
      .insert({
        driver_id: driverId,
        storage_path: '',
        status: 'pending',
      })
      .select()
      .single();
    if (error) throw error;
    return data as SelfieCheck;
  },

  /**
   * Upload a selfie for an active check and mark as processing.
   */
  async uploadSelfieCheck(
    checkId: string,
    driverId: string,
    filePath: string,
    fileName: string,
  ): Promise<SelfieCheck> {
    const supabase = getSupabaseClient();

    // Upload to storage
    const response = await fetch(filePath);
    const blob = await response.blob();
    const storagePath = `selfie-checks/${driverId}/${checkId}/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('driver-documents')
      .upload(storagePath, blob, { upsert: true });
    if (uploadError) throw uploadError;

    // Update check record
    const { data, error } = await supabase
      .from('selfie_checks')
      .update({
        storage_path: storagePath,
        status: 'processing',
      })
      .eq('id', checkId)
      .select()
      .single();
    if (error) throw error;

    // Invoke Edge Function for face matching with retry (max 3 attempts)
    const invokeSelfieVerification = async (attempt = 1) => {
      try {
        await supabase.functions.invoke('verify-selfie', {
          body: { check_id: checkId, driver_id: driverId },
        });
      } catch (err) {
        if (attempt < 3) {
          // Exponential backoff: 2s, 4s
          await new Promise<void>((r) => setTimeout(r, attempt * 2000));
          return invokeSelfieVerification(attempt + 1);
        }
        // After 3 failures, mark the check as failed so it doesn't stay in 'processing' forever
        console.error('verify-selfie invoke failed after 3 attempts:', err);
        try {
          await supabase
            .from('selfie_checks')
            .update({ status: 'failed' })
            .eq('id', checkId);
        } catch { /* best effort */ }
      }
    };
    invokeSelfieVerification();

    return data as SelfieCheck;
  },

  /**
   * Complete a selfie check (called by Edge Function or admin).
   */
  async completeSelfieCheck(
    checkId: string,
    passed: boolean,
    faceMatchScore?: number,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('selfie_checks')
      .update({
        status: passed ? 'passed' : 'failed',
        face_match_score: faceMatchScore ?? null,
        liveness_passed: passed,
        completed_at: new Date().toISOString(),
      })
      .eq('id', checkId);
    if (error) throw error;
  },

  /**
   * Get the latest selfie check for a driver.
   */
  async getLatestSelfieCheck(
    driverId: string,
  ): Promise<SelfieCheck | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('selfie_checks')
      .select('*')
      .eq('driver_id', driverId)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as SelfieCheck | null;
  },

  /**
   * Get selfie check history for a driver.
   */
  async getSelfieChecks(
    driverId: string,
    limit = 10,
  ): Promise<SelfieCheck[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('selfie_checks')
      .select('*')
      .eq('driver_id', driverId)
      .order('requested_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data as SelfieCheck[];
  },
};
