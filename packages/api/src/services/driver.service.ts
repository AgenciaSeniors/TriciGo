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
import { getSupabaseClient } from '../client';

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
   */
  async acceptRide(rideId: string, driverId: string): Promise<Ride> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('rides')
      .update({
        driver_id: driverId,
        status: 'accepted' as RideStatus,
        accepted_at: new Date().toISOString(),
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
