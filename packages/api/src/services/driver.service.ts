// ============================================================
// TriciGo — Driver Service
// Driver-specific operations: onboarding, status, trips.
// ============================================================

import type {
  DriverProfile,
  DriverMatchPreferences,
  DriverDocument,
  DriverPeakHourCell,
  DriverPerformanceTrendDay,
  DriverActiveWorkSession,
  DriverWorkAdherenceDay,
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
import { logger } from '@tricigo/utils';
import { AppError } from '../errors';
import { getSupabaseClient } from '../client';
import { uploadFileFromUri } from './_storage-upload';
import { notificationService } from './notification.service';
import { exchangeRateService } from './exchange-rate.service';

import { transformRideCoordinates } from './_ride-coordinates';

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
   * Resilient profile fetch used by the app's boot/routing logic.
   *
   * `getProfile` collapses two very different outcomes into `null`/throw:
   *   - the row is genuinely absent (a brand-new applicant), and
   *   - the fetch FAILED (network timeout, transient DB error, token race).
   * Routing that treats both as "no profile → onboarding" wrongly bounces an
   * already-approved driver back into the registration form when their fetch
   * merely fails — very common on flaky Cuban connectivity.
   *
   * This returns a discriminated result so the caller can tell them apart, and
   * retries transient failures before giving up. A genuine `null` (row absent,
   * no error) is returned immediately as `{ ok: true, profile: null }` and is
   * NOT retried.
   */
  async getProfileResilient(
    userId: string,
    opts?: { retries?: number; delayMs?: number; timeoutMs?: number },
  ): Promise<{ ok: true; profile: DriverProfile | null } | { ok: false; error: unknown }> {
    const retries = opts?.retries ?? 3;
    const delayMs = opts?.delayMs ?? 600;
    const timeoutMs = opts?.timeoutMs ?? 8000;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Time-box each attempt so a hung getProfile (flaky network / stalled
        // socket) fails fast into the retry/spinner path instead of stalling the
        // whole boot. The auth hook used to withTimeout(getProfile); that
        // fail-fast lives here now that the profile layer is getProfileResilient.
        const profile = await Promise.race([
          this.getProfile(userId),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`getProfile timed out after ${timeoutMs}ms`)),
              timeoutMs,
            );
          }),
        ]);
        // Success — includes a genuine `null` (row absent). Do not retry.
        return { ok: true, profile };
      } catch (error) {
        lastError = error;
        if (attempt < retries && delayMs > 0) {
          // Linear-ish backoff; keeps the app on a spinner, not the reg form.
          await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
        }
      } finally {
        // Always clear the timeout timer so a fast success/failure never leaks a
        // pending timer (which would keep the process — and vitest — alive).
        if (timer) clearTimeout(timer);
      }
    }

    logger.warn('[driverService] getProfileResilient exhausted retries', { userId });
    return { ok: false, error: lastError };
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
    mimeType: string = 'image/jpeg',
  ): Promise<DriverDocument> {
    const supabase = getSupabaseClient();

    // Upload file to Supabase Storage (RN-safe via FormData — see _storage-upload.ts).
    const storagePath = `driver-docs/${driverId}/${documentType}/${fileName}`;
    await uploadFileFromUri('driver-documents', storagePath, filePath, {
      fileName,
      mimeType,
      upsert: true,
    });

    // Create document record
    const { data, error } = await supabase
      .from('driver_documents')
      .insert({
        driver_id: driverId,
        document_type: documentType,
        storage_path: storagePath,
        file_name: fileName,
        mime_type: mimeType,
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
   *
   * `termsAccepted` stamps driver_profiles.terms_accepted_at (00405) in
   * the SAME update as the status change, so the contract trigger sees
   * it already set. The column may not exist yet (migration pending) —
   * acceptance tracking must never block onboarding, so on a
   * column-missing error we retry with the status change alone.
   */
  async submitForVerification(driverId: string, opts?: { termsAccepted?: boolean }): Promise<void> {
    const supabase = getSupabaseClient();
    const update: Record<string, unknown> = { status: 'under_review' as DriverStatus };
    if (opts?.termsAccepted) update.terms_accepted_at = new Date().toISOString();
    const { error } = await supabase
      .from('driver_profiles')
      .update(update)
      .eq('id', driverId);
    if (error && opts?.termsAccepted && /column|schema cache/i.test(error.message)) {
      const { error: retryErr } = await supabase
        .from('driver_profiles')
        .update({ status: 'under_review' as DriverStatus })
        .eq('id', driverId);
      if (retryErr) throw retryErr;
      return;
    }
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

    // 00491: going online requires a registered active vehicle. The DB trigger
    // enforces this authoritatively; this pre-check surfaces a clean error
    // instead of the raw trigger exception (and avoids a wasted round-trip).
    if (isOnline) {
      const { data: activeVehicle } = await supabase
        .from('vehicles')
        .select('id')
        .eq('driver_id', driverId)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();
      if (!activeVehicle) {
        throw new Error('driver_has_no_active_vehicle_for_online');
      }
    }

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
    _activeRideId?: string,
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
    // AUD2-003 (privacy, audit 2026-06-20 pass 2): removed the public GPS broadcasts to
    // `driver-location-{driverId}` and `ride-driver-location-{rideId}`. Those broadcast channels were
    // UNAUTHENTICATED (any client could subscribe to a predictable id and track a driver's live GPS)
    // AND already dead: every consumer (web + mobile) polls the RLS-gated `get_driver_position` RPC
    // (BUG-277 polling architecture). The driver_profiles update above is the source of truth.
  },

  /**
   * BUG-275: atomic driver position update — one RPC call instead of two
   * separate POSTs (driver_profiles UPDATE + ride_location_events INSERT).
   * Cuts the per-second request rate in half, which on Cloudflare-fronted
   * Supabase eliminates the random POST failures observed during active
   * trips at high GPS sample rates.
   */
  async updateDriverPosition(params: {
    driverId: string;
    latitude: number;
    longitude: number;
    heading?: number;
    speed?: number;
    rideId?: string;
  }): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('update_driver_position', {
      p_driver_id: params.driverId,
      p_latitude: params.latitude,
      p_longitude: params.longitude,
      p_heading: params.heading ?? null,
      p_speed: params.speed ?? null,
      p_ride_id: params.rideId ?? null,
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
  },

  /**
   * Send heartbeat to keep driver marked as online.
   * Called every 60s by the driver app. Stale drivers (no heartbeat for 3min)
   * are marked offline by the mark_stale_drivers_offline() pg_cron function.
   */
  async sendHeartbeat(driverId: string): Promise<void> {
    const supabase = getSupabaseClient();
    await supabase.rpc('driver_heartbeat', { p_driver_id: driverId });
  },

  /**
   * Accept a ride request.
   * Snapshots the driver's custom per-km rate and recalculates the fare
   * using the driver's rate (or platform default if not set).
   */
  async acceptRide(rideId: string, driverId: string): Promise<Ride> {
    const supabase = getSupabaseClient();

    // Single atomic RPC: authorization + offer validation + heartbeat check
    // + active-ride check + fare calculation + ride/offer mutations.
    // See migration 00142_accept_ride_v2.sql. Prior versions did 3 RLS-gated
    // SELECTs BEFORE the RPC, which could fail (offer expired, network) and
    // leave the driver with a misleading error while the RPC never fired.
    const { data: result, error: rpcError } = await supabase.rpc('accept_ride_v2', {
      p_ride_id: rideId,
      p_driver_id: driverId,
    });

    if (rpcError) throw rpcError;

    logger.info('[Accept] RPC v2 result', {
      ride_id: rideId,
      result: result?.success ? 'ok' : result?.error,
      idempotent: result?.idempotent || false,
    });

    if (result?.error) {
      // Idempotent path is reported as success: true with idempotent: true.
      // Surface the raw RPC payload on the Error object so callers can
      // distinguish 'insufficient_balance' (and pull balance_trc /
      // required_trc) from generic failures without re-parsing strings.
      const err = new Error(String(result.error)) as Error & {
        rpcError?: string;
        rpcPayload?: Record<string, unknown>;
      };
      err.rpcError = String(result.error);
      err.rpcPayload = result as Record<string, unknown>;
      throw err;
    }

    // Fetch the updated ride to return (RLS now passes because driver_id = self)
    const { data: updatedRide, error: fetchErr } = await supabase
      .from('rides')
      .select('*')
      .eq('id', rideId)
      .single();
    if (fetchErr) throw fetchErr;

    // Convert PostGIS geography (WKB hex) to { latitude, longitude } GeoPoint
    // objects so RideMapView can render pickup/dropoff markers + auto-fit
    // camera to the route. Without this, `activeTrip.pickup_location` would
    // be a raw WKB string and the map renders empty (no pins, no bounds).
    // Other driver.service.ts methods already do this — accept path was
    // missed in the v2 refactor.
    const acceptedRide = transformRideCoordinates(updatedRide as Record<string, unknown>);

    // Notify customer — delivery-specific message (non-blocking)
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
    opts?: { driverLat?: number; driverLng?: number; confirmFar?: boolean },
  ): Promise<{
    success: boolean;
    gated?: boolean;
    reason?: string;
    distance_m?: number;
    target?: string;
    threshold_m?: number;
    rider_bypass_used?: boolean;
    offline_trail_used?: boolean;
    trail_arrived_at?: string;
    far_from_pin_override?: boolean;
  }> {
    if (status === 'completed') {
      throw new Error('Use completeRide() for ride completion');
    }

    const supabase = getSupabaseClient();

    // BUG-244: route through update_ride_status_v2 RPC for proximity gate
    // on arrived_at_pickup / arrived_at_destination. Other transitions
    // pass through unchanged.
    // p_no_gps_mode is deliberately NOT sent. The RPC still declares it (with a
    // default) so installed builds that pass it keep resolving, but the body has
    // never read it — see migration 00522. The broken-GPS path is the separate
    // rider-consent flow: reportGpsUnavailable -> rider_respond_to_gps_unavailable
    // -> driver_gps_status='rider_consented', which update_ride_status_v2 honours.
    // p_confirm_far (00537) is only included when true so builds talking to a
    // backend without the param keep resolving the 5-arg signature.
    const { data, error } = await supabase.rpc('update_ride_status_v2', {
      p_ride_id: rideId,
      p_new_status: status,
      p_driver_lat: opts?.driverLat ?? null,
      p_driver_lng: opts?.driverLng ?? null,
      ...(opts?.confirmFar ? { p_confirm_far: true } : {}),
    });
    if (error) {
      // 00537: the RPC signals machine-readable outcomes in DETAIL (PostgREST
      // exposes it as error.details): 'too_far_for_bypass' | 'gps_required'.
      // Throw a typed AppError so the caller can branch on the code (far-pin
      // override modal) instead of string-matching the Spanish message.
      const detail = (error as { details?: string }).details;
      const code =
        detail === 'too_far_for_bypass' ? 'TOO_FAR_FOR_BYPASS'
        : detail === 'gps_required' ? 'GPS_REQUIRED'
        : 'RIDE_STATUS_UPDATE_FAILED';
      throw new AppError(
        error.message || JSON.stringify(error),
        code,
        400,
        { detail: detail ?? null },
      );
    }
    const result = data as {
      success: boolean;
      gated?: boolean;
      reason?: string;
      distance_m?: number;
      target?: string;
      threshold_m?: number;
      rider_bypass_used?: boolean;
      offline_trail_used?: boolean;
      trail_arrived_at?: string;
      far_from_pin_override?: boolean;
      new_status?: string;
    };
    // If gated, the caller decides what to do (show "rider confirm?" prompt)
    if (result?.gated) {
      return result;
    }

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
    return result;
  },

  /**
   * BUG-244: rider confirms driver arrived (used when GPS gate is between
   * 100m and 500m and the rider can visually confirm).
   */
  async riderConfirmDriverArrival(rideId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('rider_confirm_driver_arrival', {
      p_ride_id: rideId,
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
  },

  /**
   * BUG-246: driver reports their GPS as unavailable for this ride.
   * Backend flips ride.driver_gps_status to 'unavailable' which triggers
   * a rider-side modal asking for consent to continue.
   */
  async reportGpsUnavailable(rideId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('report_driver_gps_unavailable', {
      p_ride_id: rideId,
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
  },

  /**
   * BUG-246: driver reports GPS recovered. Best-effort: only flips back
   * to 'healthy' if rider hasn't already consented (preserves audit trail).
   */
  async reportGpsRecovered(rideId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('report_driver_gps_recovered', {
      p_ride_id: rideId,
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
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
   * BUG-222: driver justifies why their route exceeded 1.3× the estimate.
   * Called from the post-completion modal when excess_distance_uncharged_m > 0.
   */
  async setExcessDistanceReason(rideId: string, reason: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('set_excess_distance_reason', {
      p_ride_id: rideId,
      p_reason: reason,
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
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
    // Join the final pricing snapshot so the earnings screen can show
    // the *actual* server-recorded commission (from migration 00112)
    // instead of recomputing `fare * current_rate` client-side. The
    // recomputation was wrong whenever the commission rate had been
    // changed between the ride's completion and the query — old rides
    // showed rates they weren't actually billed at. Reading the
    // snapshot is the source of truth.
    const { data, error } = await supabase
      .from('rides')
      .select('id, status, created_at, completed_at, final_fare_cup, estimated_fare_cup, final_fare_trc, actual_distance_m, actual_duration_s, service_type, payment_method, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, ride_pricing_snapshots(snapshot_type, commission_amount)')
      .eq('driver_id', driverId)
      .eq('status', 'completed')
      .gte('completed_at', startDate)
      .lte('completed_at', endDate)
      .order('completed_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    // Flatten the nested final-snapshot into a top-level
    // `commission_amount` field so callers don't need to deal with the
    // array. `ride_pricing_snapshots` is 1:N (estimate + final), so
    // pick the `final` row.
    return (data ?? []).map((r) => {
      const snaps = (r as Record<string, unknown>).ride_pricing_snapshots as
        | Array<{ snapshot_type?: string; commission_amount?: number }>
        | null
        | undefined;
      const finalSnap = snaps?.find((s) => s.snapshot_type === 'final');
      return transformRideCoordinates({
        ...(r as Record<string, unknown>),
        ride_pricing_snapshots: undefined,
        commission_amount: finalSnap?.commission_amount ?? null,
      });
    });
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

    // BUG-fare-display-parity: join `ride_pricing_snapshots` to flatten
    // the snapshotted `commission_amount` onto each ride row. Without
    // it the trips list falls back to `fare × live_commission_rate`,
    // which drifts whenever platform_config.commission_rate changes
    // after a ride completes. Mirrors the join in `getRideHistoryFiltered`
    // (line 640) which already does this for the home earnings counter.
    let query = supabase
      .from('rides')
      .select('*, ride_pricing_snapshots(snapshot_type, commission_amount)')
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
    // Flatten the nested final-snapshot into a top-level `commission_amount`
    // field so `tripNetEarnings()` can prefer the snapshot over a recalc.
    return (data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      const snaps = row.ride_pricing_snapshots as
        | Array<{ snapshot_type?: string; commission_amount?: number }>
        | null
        | undefined;
      const finalSnap = snaps?.find((s) => s.snapshot_type === 'final');
      return transformRideCoordinates({
        ...row,
        ride_pricing_snapshots: undefined,
        commission_amount: finalSnap?.commission_amount ?? null,
      });
    });
  },

  // ==================== AUTO-ACCEPT ====================

  /**
   * Enable or disable auto-accept for incoming rides.
   *
   * INERT — has no callers, and enabling it would change nothing. No
   * database function reads `driver_profiles.auto_accept_enabled`
   * (verified against production 2026-07): dispatch creates a
   * `ride_offers` row and waits for the driver either way. Nothing
   * auto-accepts on their behalf.
   *
   * Kept because the column and this setter are the natural place to
   * build on if auto-accept is ever implemented, but do NOT wire a
   * settings toggle to it as-is — that would give drivers a switch that
   * silently does nothing, which is exactly the problem the 2026-07
   * settings audit was cleaning up.
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
      // total_rides_completed is the MAINTAINED counter (incremented by
      // complete_ride_and_pay). total_rides is a legacy cache that nothing
      // keeps in sync — reading it lets a drifted driver bypass the 50-ride
      // gate (e.g. legacy=120 while real completed=7).
      .select('total_rides_completed, rating_avg')
      .eq('id', driverId)
      .single();
    if (!data) return false;
    return (data.total_rides_completed ?? 0) >= 50 && (data.rating_avg ?? 0) >= 4.5;
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
   *
   * Historically this made a pre-RPC `check_accept_ride_eligibility` call
   * based on the is_financially_eligible flag (24h-grace, -50 CUP threshold).
   * Migration 00153 moves the authoritative balance gate inside
   * `accept_ride_v2` itself — the RPC now rejects with error
   * 'insufficient_balance' when driver_cash < estimated commission.
   *
   * We keep the flag check as a coarse pre-filter (cheaper round-trip for
   * drivers already flagged ineligible for other admin reasons) and let
   * the RPC's per-ride gate be the source of truth.
   */
  async acceptRideWithEligibility(rideId: string, driverId: string): Promise<Ride> {
    const supabase = getSupabaseClient();

    // Fast coarse pre-filter — only catches drivers admins have flagged
    // as financially ineligible via the 24h-grace mechanism. Missing or
    // transient failures fall through to the RPC (which has the real gate).
    const { data: eligible, error: eligErr } = await supabase.rpc(
      'check_accept_ride_eligibility',
      { p_driver_id: driverId },
    );

    if (!eligErr && eligible === false) {
      throw new Error('No puedes aceptar viajes: tu cuenta tiene un saldo negativo pendiente.');
    }

    // Real per-ride balance gate happens inside accept_ride_v2 (00153).
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

    // Fetch the current exchange rate via the shared service, which reads the
    // live `is_current` row and has its own fallback chain (platform_config →
    // DEFAULT_EXCHANGE_RATE). Avoids the old hardcoded 510 that drifted ~24%
    // below the real rate (~670) and was shown to the driver as the USD hint.
    const exchangeRate = await exchangeRateService.getUsdCupRate();

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
   * Update the driver's matching preferences in
   * `driver_profiles.preferences`.
   *
   * These are honored by `find_best_drivers` today — no migration is
   * needed. See `DriverMatchPreferences` for the exact filters.
   *
   * Pass `null` for a field to CLEAR it, which is what "no limit" means:
   * the engine's checks are `IS NULL`-guarded, so an absent key is the
   * only way to express "no restriction". Storing 0 for
   * `max_distance_km` would filter the driver out of every ride.
   *
   * Read-modify-write rather than a blind update: migration 00257
   * backfilled the column with keys the matching engine does not read
   * (`music_preference`, `accepts_minors_alone`), and overwriting the
   * whole object would silently discard them.
   */
  async updateMatchPreferences(
    driverId: string,
    updates: {
      max_distance_km?: number | null;
      accepts_long_trips?: boolean | null;
    },
  ): Promise<DriverMatchPreferences> {
    const supabase = getSupabaseClient();

    const { data: current, error: readError } = await supabase
      .from('driver_profiles')
      .select('preferences')
      .eq('id', driverId)
      .single();
    if (readError) throw readError;

    const next: Record<string, unknown> = { ...(current?.preferences ?? {}) };
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
    }

    const { error } = await supabase
      .from('driver_profiles')
      .update({ preferences: next })
      .eq('id', driverId);
    if (error) throw error;

    return next as DriverMatchPreferences;
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
      // BUG-084 fix: driver_profiles.acceptance_rate is stored as a
      // percentage (0-100, default 100.0). Other rate fields below are
      // computed as decimals (0-1). Normalize everything to decimal here
      // so the UI can uniformly multiply by 100 once for display.
      acceptanceRate: (profile.acceptance_rate ?? 0) / 100,
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

  /**
   * Phase 2 N2 — fetch per-driver earnings + trip count grouped by
   * day-of-week × hour-of-day for the last `days` days. Powers the
   * "Tus mejores horas" 7×24 heatmap on the earnings tab.
   *
   * Empty array when the driver has no completed rides in the window
   * (server returns 0 rows; we tolerate `data === null` for safety).
   */
  async getPersonalPeakHours(
    driverId: string,
    days = 30,
  ): Promise<DriverPeakHourCell[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_driver_peak_hours_personal', {
      p_driver_id: driverId,
      p_days: days,
    });
    if (error) throw error;
    return (data as DriverPeakHourCell[] | null) ?? [];
  },

  /**
   * Fetch a per-day rollup of completed/canceled/accepted rides + avg
   * response time for the last N days. Powers the 30-day sparklines on
   * `/profile/performance` (Phase 2 N3 deep slice). Backed by the RPC
   * `get_driver_performance_trend` (migration 00260).
   *
   * Returns one row per day in the window — including zero-rows for
   * days with no activity, so sparklines render contiguously.
   * Tolerates the RPC being missing (empty array) so the UI shows
   * "no data yet" instead of crashing when 00260 hasn't been applied
   * to prod.
   */
  async getPerformanceTrend(
    driverId: string,
    days = 30,
  ): Promise<DriverPerformanceTrendDay[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_driver_performance_trend', {
      p_driver_id: driverId,
      p_days: days,
    });
    if (error) {
      // Function missing in prod (00260 not applied yet) — silent
      // fallback. Other errors propagate so the caller can show a
      // proper error state.
      if (
        error.code === '42883' || // undefined_function
        error.message?.toLowerCase().includes('does not exist')
      ) {
        return [];
      }
      throw error;
    }
    return (data as DriverPerformanceTrendDay[] | null) ?? [];
  },

  /**
   * Phase 2 N6 DB-backed (00261) — returns the driver's open work
   * session (`ended_at IS NULL`) or `null` if they're offline /
   * the trigger hasn't opened one yet / 00261 isn't applied to prod.
   *
   * The home bottom-sheet uses this when available to drive the
   * fatigue banner with a cross-device timestamp; it falls back to
   * AsyncStorage `driver_online_since` when the RPC is missing or
   * returns null (e.g. legacy session opened before 00261 deployed).
   */
  async getActiveWorkSession(driverId: string): Promise<DriverActiveWorkSession | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_active_work_session', {
      p_driver_id: driverId,
    });
    if (error) {
      if (
        error.code === '42883' ||
        error.message?.toLowerCase().includes('does not exist')
      ) {
        return null;
      }
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : null;
    return (row as DriverActiveWorkSession | null) ?? null;
  },

  /**
   * Phase 2 N6 DB-backed (00261) — daily adherence: actual minutes
   * online vs planned shift minutes (from D5 `driver_recurring_shifts`)
   * for the last N days. Returns one row per day in the window. Used
   * by the performance dashboard to surface "you worked 80% of your
   * planned hours this week" insights.
   */
  async getWorkAdherence(
    driverId: string,
    days = 14,
  ): Promise<DriverWorkAdherenceDay[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_driver_work_adherence', {
      p_driver_id: driverId,
      p_days: days,
    });
    if (error) {
      if (
        error.code === '42883' ||
        error.message?.toLowerCase().includes('does not exist')
      ) {
        return [];
      }
      throw error;
    }
    return (data as DriverWorkAdherenceDay[] | null) ?? [];
  },

  // ==================== IDENTITY VERIFICATION ====================

  /**
   * Get verification status for all documents of a driver.
   *
   * Drivers may re-upload a document after rejection (or after an
   * earlier failed upload), which leaves stale rows in
   * `driver_documents`. `uploadDocument` always INSERTs a new row
   * (path is `upsert:true` in Storage but the DB row is new). Without
   * dedup, "Mis documentos" in the driver app would render the old
   * rejected tile *and* the new pending tile side by side — confusing.
   *
   * We keep only the most recent row per `document_type`, mirroring
   * the dedup the admin already does in
   * `adminService.getDriverById` (admin.service.ts:253-263).
   */
  async getDocumentVerificationStatus(
    driverId: string,
  ): Promise<DriverDocument[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_documents')
      .select('*')
      .eq('driver_id', driverId)
      .order('uploaded_at', { ascending: false });
    if (error) throw error;

    // Rows come back ordered by uploaded_at DESC, so the first
    // occurrence per type is the latest.
    const latestByType = new Map<string, DriverDocument>();
    for (const doc of ((data ?? []) as DriverDocument[])) {
      if (!latestByType.has(doc.document_type)) {
        latestByType.set(doc.document_type, doc);
      }
    }
    return Array.from(latestByType.values());
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

    // Upload to storage (RN-safe via FormData — see _storage-upload.ts).
    // fetch(uri).blob() throws "Network request failed" on native.
    const storagePath = `selfie-checks/${driverId}/${checkId}/${fileName}`;
    await uploadFileFromUri('driver-documents', storagePath, filePath, {
      fileName,
      upsert: true,
    });

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
