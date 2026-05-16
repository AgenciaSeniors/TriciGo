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
  DemandHotspot,
  PopularLocation,
  RideOfferStats,
  TripInsuranceConfig,
  RidePreferences,
  CancellationFeePreview,
  Waypoint,
  RideSplit,
  SharedRideView,
  SharedTripState,
} from '@tricigo/types';
import type { PackageCategory, PaymentMethod, RideStatus, ServiceTypeSlug, VehicleType } from '@tricigo/types';
import {
  haversineDistance,
  estimateRoadDistance,
  estimateDuration,
  adjustRouteDuration,
  calculateTripDuration,
  cupToTrc,
  calculateBaseFare,
  calculateCargoFare,
  applySurge,
  matchPricingRule,
  calculateFareRange,
  maskPhone,
  isLocationInCuba,
  fetchRoute,
  fetchMultiStopRoute,
} from '@tricigo/utils';
import { getSupabaseClient } from '../client';
import { exchangeRateService } from './exchange-rate.service';
import { corporateService } from './corporate.service';
import { matchingService } from './matching.service';
import { notificationService } from './notification.service';
import { validate, createRideSchema } from '../schemas';
import { logger } from '@tricigo/utils';
import { AuthError, ValidationError, ForbiddenError } from '../errors';
import { deliveryService } from './delivery.service';

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
  wallet_ratio?: number;
  ride_mode?: 'passenger' | 'cargo';
  delivery_details?: {
    package_description: string;
    recipient_name: string;
    recipient_phone: string;
    estimated_weight_kg?: number | null;
    special_instructions?: string | null;
    package_category?: string | null;
    package_length_cm?: number | null;
    package_width_cm?: number | null;
    package_height_cm?: number | null;
    client_accompanies?: boolean;
    delivery_vehicle_type?: string | null;
  };
}

// ─── In-flight request dedupe (coalesces concurrent calls) ───
// Used to prevent the 4-service-type fare estimate burst from firing
// the same heavy request (Mapbox route, surge RPC, exchange rate)
// four times in parallel. TTL short enough that stale data is never
// an issue for fare previews.
const _dedupeCache = new Map<string, { at: number; promise: Promise<unknown> }>();
const DEDUPE_TTL_MS = 20_000;

function dedupe<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = _dedupeCache.get(key);
  if (existing && Date.now() - existing.at < DEDUPE_TTL_MS) {
    return existing.promise as Promise<T>;
  }
  const promise = fetcher().finally(() => {
    // Keep resolved value for TTL so repeat callers within the window
    // still get it; only expire via the at-check above.
  });
  _dedupeCache.set(key, { at: Date.now(), promise });
  // Garbage-collect expired entries opportunistically.
  if (_dedupeCache.size > 50) {
    const now = Date.now();
    for (const [k, v] of _dedupeCache) {
      if (now - v.at > DEDUPE_TTL_MS) _dedupeCache.delete(k);
    }
  }
  return promise;
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
    waypoints?: { lat: number; lng: number }[];
  }): Promise<FareEstimate> {
    // Validate ride distance is within reasonable bounds (50km max)
    const directDistance = haversineDistance(
      { latitude: params.pickup_lat, longitude: params.pickup_lng },
      { latitude: params.dropoff_lat, longitude: params.dropoff_lng },
    );
    if (directDistance > 50_000) {
      throw new ValidationError('Ride distance exceeds maximum allowed (50km)');
    }

    const supabase = getSupabaseClient();

    const pickup = { latitude: params.pickup_lat, longitude: params.pickup_lng };
    const dropoff = { latitude: params.dropoff_lat, longitude: params.dropoff_lng };

    // ─── Parallel Block: fetch all independent data at once ───
    // Shared fetches (route, surge, exchange rate) are keyed by their
    // inputs and deduped — so when the home screen fires 4 concurrent
    // getLocalFareEstimate calls (one per service_type), each shared
    // request hits the wire exactly once instead of four times.
    const waypointKeyPart = params.waypoints?.map((w) => `${w.lat.toFixed(6)},${w.lng.toFixed(6)}`).join('+') ?? '';
    const routeKey = `route:${params.pickup_lat.toFixed(6)},${params.pickup_lng.toFixed(6)}->${waypointKeyPart ? waypointKeyPart + '->' : ''}${params.dropoff_lat.toFixed(6)},${params.dropoff_lng.toFixed(6)}`;
    const surgeKey = `surge:${params.pickup_lat.toFixed(4)},${params.pickup_lng.toFixed(4)}`;
    const exchangeKey = 'exchange:usd_cup';

    const allRoutePoints = [
      { lat: params.pickup_lat, lng: params.pickup_lng },
      ...(params.waypoints ?? []),
      { lat: params.dropoff_lat, lng: params.dropoff_lng },
    ];

    const [configResult, rulesResult, routeResult, surgeResult, experimentResult, exchangeRate] =
      await Promise.all([
        supabase
          .from('service_type_configs')
          .select('*')
          .eq('slug', params.service_type)
          .eq('is_active', true)
          .single(),
        supabase
          .from('pricing_rules')
          .select('*')
          .eq('service_type', params.service_type)
          .eq('is_active', true),
        dedupe(routeKey, () =>
          allRoutePoints.length > 2
            ? fetchMultiStopRoute(allRoutePoints).catch(() => null)
            : fetchRoute(
                { lat: params.pickup_lat, lng: params.pickup_lng },
                { lat: params.dropoff_lat, lng: params.dropoff_lng },
              ).catch(() => null),
        ),
        dedupe(surgeKey, () =>
          Promise.resolve(supabase.rpc('calculate_dynamic_surge', {
            p_zone_id: null,
            p_lat: params.pickup_lat,
            p_lng: params.pickup_lng,
            p_radius_m: 3000,
          })).catch(() => {
            console.warn('[ride.service] Surge RPC failed, falling back to multiplier 1.0');
            return { data: 1.0 as number, error: null };
          }),
        ),
        supabase
          .from('pricing_experiments')
          .select('*')
          .eq('status', 'active')
          .eq('service_type', params.service_type)
          .maybeSingle(),
        dedupe(exchangeKey, () => exchangeRateService.getUsdCupRate().catch(() => 300)),
      ]);

    if (configResult.error) throw configResult.error;
    const svcConfig = configResult.data as ServiceTypeConfig | null;
    if (!svcConfig) throw new Error(`Service type config not found for ${params.service_type}`);
    const pricingRules = rulesResult.data;

    // Find matching time-based rule (using pure function)
    const now = new Date();
    const currentHour = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const currentDay = now.getDay(); // 0=Sun, 6=Sat

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

    // BUG-221: separate two durations.
    //   - displayDuration → shown to the user (per-vehicle SPEED_PROFILE,
    //     e.g. triciclo 9.4 km/h ≈ 64 min for 9.9 km).
    //   - fareDuration → fed into per-minute fare component, calculated
    //     using OSRM's neutral car-equivalent time (~40 km/h ≈ 15 min for
    //     9.9 km). Without this split, slow vehicles (triciclo) would be
    //     PUNISHED by their own slowness on long trips: per_minute × 64
    //     blows up the fare. Rates per service still differ (triciclo has
    //     lower per_km/per_min than auto), so the relative ordering is
    //     preserved without time penalising the slow option.
    let roadDistance: number;
    let displayDuration: number;
    let fareDuration: number;
    if (routeResult) {
      roadDistance = routeResult.distance_m;
      displayDuration = calculateTripDuration(routeResult.distance_m, params.service_type);
      fareDuration = routeResult.duration_s; // neutral OSRM duration
    } else {
      const straightLine = haversineDistance(pickup, dropoff);
      roadDistance = estimateRoadDistance(straightLine);
      displayDuration = estimateDuration(roadDistance, params.service_type);
      // No OSRM result; approximate neutral duration with auto profile.
      fareDuration = estimateDuration(roadDistance, 'auto_standard');
    }

    const distanceKm = roadDistance / 1000;
    const fareDurationMin = fareDuration / 60;

    // Calculate fare using pure function — uses fareDuration (neutral)
    const isCargo = params.service_type === 'triciclo_cargo';
    const fareResult = isCargo
      ? calculateCargoFare({
          durationMin: fareDurationMin > 0 ? fareDurationMin : 60, // default 1 hour
          baseFare,
          perMinRate,
          minimumFare: minFare,
        })
      : calculateBaseFare({
          distanceKm,
          durationMin: fareDurationMin,
          baseFare,
          perKmRate,
          perMinRate,
          minimumFare: minFare,
        });

    // ─── Dynamic Surge (conditional weather check) ───
    let surgeMultiplier = 1.0;
    let surgeType: SurgeType = 'none';

    try {
      const surgeData = surgeResult.data;
      if (typeof surgeData === 'number' && surgeData > 1.0) {
        surgeMultiplier = surgeData;

        // Only check weather surge if surge is active (conditional query)
        const { data: weatherSurge } = await supabase
          .from('surge_zones')
          .select('id')
          .like('reason', 'weather_%')
          .eq('active', true)
          .limit(1);

        const hasWeatherSurge = weatherSurge && weatherSurge.length > 0;
        const hasTimeRule = pricingRules && (pricingRules as PricingRule[]).some(
          (r: PricingRule) => r.time_window_start && r.time_window_end,
        );
        surgeType = hasWeatherSurge ? 'weather' : hasTimeRule ? 'combined' : 'demand';
      }
    } catch {
      console.warn('Surge processing failed, defaulting to 1.0x');
    }

    let surgedFare = applySurge(fareResult.fare, surgeMultiplier);

    // ─── A/B Pricing Experiment (conditional user check) ───
    try {
      const experiment = experimentResult.data;
      if (experiment) {
        // Only fetch user if we have an active experiment
        const userId = (await supabase.auth.getUser()).data.user?.id;
        if (userId) {
          // Simple hash: sum of char codes mod 2
          const hash = userId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
          const isVariantB = hash % 2 === 1;
          const variant = isVariantB ? 'b' : 'a';
          const multiplier = isVariantB ? experiment.variant_b_multiplier : experiment.variant_a_multiplier;

          // Apply experiment multiplier to fare
          if (multiplier && multiplier !== 1.0) {
            surgedFare = Math.round(surgedFare * multiplier);
          }

          // Increment rides counter (non-blocking, fire-and-forget)
          void supabase.rpc('increment_experiment_rides', {
            p_experiment_id: experiment.id,
            p_variant: variant,
          });
        }
      }
    } catch { /* experiments are optional, don't break pricing */ }

    // ─── Exchange Rate: convert CUP → TRC ───
    const estimatedFareTrc = cupToTrc(surgedFare);

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
        insurancePremiumTrc = cupToTrc(premium);
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
      // BUG-221 (final): expose PER-VEHICLE duration to the client so each
      // card shows the realistic ETA for that specific service (moto 25,
      // triciclo 64, auto 30, confort 28). The FARE component still uses
      // fareDuration (neutral 40 km/h) internally so slow vehicles aren't
      // punished — but the user-facing "min" reflects what they'll actually
      // experience in the trip.
      estimated_duration_s: displayDuration,
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

    // Validate coordinates are within Cuba (skipped in demo mode for testing abroad)
    const IS_DEMO = process.env.EXPO_PUBLIC_DEMO_MODE === 'true';
    if (!IS_DEMO) {
      if (!isLocationInCuba(validParams.pickup_latitude, validParams.pickup_longitude)) {
        throw new ValidationError('Pickup location is outside the service area');
      }
      if (!isLocationInCuba(validParams.dropoff_latitude, validParams.dropoff_longitude)) {
        throw new ValidationError('Dropoff location is outside the service area');
      }
    }

    const supabase = getSupabaseClient();

    // Get current user for customer_id
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new AuthError();

    // Snapshot exchange rate at ride creation for consistent pricing
    const exchangeRate = await exchangeRateService.getUsdCupRate();
    const estimatedFareTrc = validParams.estimated_fare_cup
      ? cupToTrc(validParams.estimated_fare_cup)
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
        throw new ValidationError(validation.reason ?? 'Corporate ride validation failed');
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
        ride_mode: validParams.ride_mode ?? 'passenger',
        wallet_ratio: validParams.wallet_ratio ?? 0,
        status: 'searching' as RideStatus,
      })
      .select()
      .single();
    if (error) {
      // PostgrestError from Supabase is a plain object, not an Error
      // instance. If we throw it raw, callers that do `String(err)` or
      // `err instanceof Error` get "[object Object]" / `false`. Wrap
      // the most informative field in a real Error so the booking-page
      // toast (apps/web/src/app/book/page.tsx) can render `err.message`.
      const detail = error.message || error.details || error.hint || error.code || 'unknown error';
      throw new Error(`createRide failed: ${detail}`);
    }

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

    // Create delivery details if cargo ride
    if (validParams.ride_mode === 'cargo' && validParams.delivery_details) {
      try {
        await deliveryService.createDeliveryDetails({
          ride_id: rideData.id,
          package_description: validParams.delivery_details.package_description,
          recipient_name: validParams.delivery_details.recipient_name,
          recipient_phone: validParams.delivery_details.recipient_phone,
          estimated_weight_kg: validParams.delivery_details.estimated_weight_kg ?? undefined,
          special_instructions: validParams.delivery_details.special_instructions ?? undefined,
          package_category: (validParams.delivery_details.package_category ?? 'paquete_pequeno') as PackageCategory,
          package_length_cm: validParams.delivery_details.package_length_cm ?? undefined,
          package_width_cm: validParams.delivery_details.package_width_cm ?? undefined,
          package_height_cm: validParams.delivery_details.package_height_cm ?? undefined,
          client_accompanies: validParams.delivery_details.client_accompanies,
          delivery_vehicle_type: validParams.delivery_details.delivery_vehicle_type as unknown as VehicleType,
        });
      } catch (err) {
        logger.error('delivery_details_creation_failed', { error: (err as Error).message, rideId: rideData.id });
      }
    }

    logger.info('ride_created', {
      rideId: rideData.id,
      serviceType: validParams.service_type,
      userId: user.id,
    });

    // ── Match drivers (async, non-blocking) ──
    // Find best drivers and notify them via push. If no drivers found,
    // the ride stays in 'searching' status and cancel-stale-rides will
    // handle timeout after the configured window.
    this._matchDriversForRide(rideData, { ...validParams, ride_mode: validParams.ride_mode }).catch((err) => {
      logger.error('ride_creation_failed', { error: (err as Error).message, rideId: rideData.id });
    });

    return rideData;
  },

  /**
   * Internal: find and notify best drivers for a new ride.
   * Runs async after ride creation — failure here doesn't block the ride.
   */
  async _matchDriversForRide(
    ride: Ride,
    params: { pickup_latitude: number; pickup_longitude: number; service_type: string; pickup_address: string; dropoff_address: string; ride_mode?: string },
  ): Promise<void> {
    try {
      const isDelivery = params.ride_mode === 'cargo';
      const drivers = await matchingService.findBestDrivers({
        pickup_lat: params.pickup_latitude,
        pickup_lng: params.pickup_longitude,
        service_type: params.service_type,
        limit: 10,
        radius_m: 5000,
        is_delivery: isDelivery,
      });

      logger.info('drivers_matched', { rideId: ride.id, driversFound: drivers.length, isDelivery });

      if (drivers.length === 0) {
        console.warn('[Ride] No drivers found for ride', ride.id);
        return;
      }

      // Notify each matched driver via push notification
      const driverUserIds = drivers.map((d) => d.user_id).filter(Boolean);
      if (driverUserIds.length > 0) {
        const title = isDelivery ? 'Nuevo envio disponible' : 'Nuevo viaje disponible';
        const body = isDelivery
          ? `Envio de ${params.pickup_address} a ${params.dropoff_address}`
          : `De ${params.pickup_address} a ${params.dropoff_address}`;
        await notificationService.sendToMultipleUsers(
          driverUserIds,
          isDelivery ? 'new_delivery' : 'new_ride',
          {
            title,
            body,
            data: { ride_id: ride.id, type: isDelivery ? 'new_delivery' : 'new_ride' },
          },
        ).catch((err) => {
          console.warn('[Ride] Failed to notify drivers:', err);
        });
      }

      // Notify the customer that their delivery request is being matched
      if (isDelivery) {
        try {
          await notificationService.notifyUser(
            ride.customer_id,
            'Buscando conductor para tu envío',
            'Estamos buscando un conductor para recoger tu paquete',
            { ride_id: ride.id, type: 'delivery_searching' },
          );
        } catch { /* non-blocking */ }
      }
    } catch (err) {
      logger.error('ride_creation_failed', { error: (err as Error).message, rideId: ride.id });
      console.warn('[Ride] _matchDriversForRide error:', err);
    }
  },

  /**
   * Retry driver matching with an expanded search radius.
   * Called from the client when the initial search times out.
   * Returns the number of drivers notified.
   */
  async retryMatchDrivers(rideId: string, radiusM: number): Promise<number> {
    const supabase = getSupabaseClient();

    // Fetch ride and validate status — select only needed columns
    const { data: ride, error } = await supabase
      .from('rides')
      .select('id, status, ride_mode, service_type, pickup_lat, pickup_lng, pickup_address, dropoff_address')
      .eq('id', rideId)
      .single();
    if (error) throw error;
    if (!ride) throw new ValidationError('Ride not found');

    if (ride.status !== 'searching') {
      logger.info('retry_match_skipped', { rideId, status: ride.status });
      return 0;
    }

    try {
      const isDelivery = ride.ride_mode === 'cargo';
      const drivers = await matchingService.findBestDrivers({
        pickup_lat: ride.pickup_lat,
        pickup_lng: ride.pickup_lng,
        service_type: ride.service_type,
        limit: 10,
        radius_m: radiusM,
        is_delivery: isDelivery,
      });

      logger.info('retry_drivers_matched', { rideId, radiusM, driversFound: drivers.length, isDelivery });

      if (drivers.length === 0) return 0;

      // Notify each matched driver via push notification
      const driverUserIds = drivers.map((d) => d.user_id).filter(Boolean);
      if (driverUserIds.length > 0) {
        const title = isDelivery ? 'Nuevo env\u00edo disponible' : 'Nuevo viaje disponible';
        const body = isDelivery
          ? `Env\u00edo de ${ride.pickup_address} a ${ride.dropoff_address}`
          : `De ${ride.pickup_address} a ${ride.dropoff_address}`;
        await notificationService.sendToMultipleUsers(
          driverUserIds,
          isDelivery ? 'new_delivery' : 'new_ride',
          {
            title,
            body,
            data: { ride_id: ride.id, type: isDelivery ? 'new_delivery' : 'new_ride' },
          },
        ).catch((err) => {
          logger.warn('retry_notify_failed', { error: String(err), rideId });
        });
      }

      return driverUserIds.length;
    } catch (err) {
      logger.error('retry_match_failed', { error: (err as Error).message, rideId, radiusM });
      return 0;
    }
  },

  /**
   * Get a ride with driver details (manual join).
   */
  async getRideWithDriver(rideId: string): Promise<RideWithDriver | null> {
    const supabase = getSupabaseClient();

    // Fetch ride — pickup_lat/lng and dropoff_lat/lng columns are auto-synced
    // by a trigger from the geography columns, so we read them directly.
    const { data: ride, error: rideError } = await supabase
      .from('rides')
      .select('*')
      .eq('id', rideId)
      .maybeSingle();
    if (rideError) throw rideError;
    if (!ride) return null;

    const rideData: Ride = {
      ...(ride as Ride),
      pickup_location: { latitude: ride.pickup_lat ?? 0, longitude: ride.pickup_lng ?? 0 },
      dropoff_location: { latitude: ride.dropoff_lat ?? 0, longitude: ride.dropoff_lng ?? 0 },
    };
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
      vehicle_type: null,
    };

    // If driver assigned, fetch details
    if (rideData.driver_id) {
      // BUG-123: dp_select_own no longer has the public "approved + online"
      // clause, so the rider can't read driver_profiles directly anymore.
      // get_assigned_driver_info() is a SECURITY DEFINER RPC that returns
      // only the safe fields (rating + ride count) and gates access to the
      // rider on an active/recent ride with this driver.
      const { data: assignedRows } = await supabase
        .rpc('get_assigned_driver_info', { p_driver_profile_id: rideData.driver_id });
      const driverProfile = (assignedRows && assignedRows[0]) as
        { user_id: string; rating_avg: number | null; total_rides_completed: number | null }
        | undefined;

      if (driverProfile) {
        result.driver_user_id = driverProfile.user_id;
        result.driver_rating = driverProfile.rating_avg;
        result.driver_total_rides = driverProfile.total_rides_completed ?? null;

        // Fetch user info for driver name/phone. RLS on public.users blocks
        // the rider from reading the driver's row, so try the direct read
        // first (works when caller IS the driver) and fall back to the
        // membership-gated RPC `get_ride_party_profiles` when it returns
        // null. Phone stays under the original RLS-aware path.
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
        } else {
          // BUG-250: rider hits RLS — use the membership-gated RPC for the
          // public bits (name, avatar). Phone stays masked-only via a
          // separate path; this only fills in display fields.
          const { data: parties } = await supabase
            .rpc('get_ride_party_profiles', { p_ride_id: rideId })
            .maybeSingle<{
              driver_name: string;
              driver_avatar_url: string | null;
              driver_rating: number;
            }>();
          if (parties) {
            result.driver_name = parties.driver_name;
            result.driver_avatar_url = parties.driver_avatar_url;
          }
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
      result.waypoints = waypoints as Ride['waypoints'];
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

    // BUG-250: RLS on public.users blocks the driver from SELECTing the rider's
    // row. Direct query silently returned null and the rating sheet fell back
    // to "Pasajero". Use the SECURITY DEFINER RPC `get_ride_party_profiles`
    // which gates by ride membership and returns the public profile fields.
    const { data: parties } = await supabase
      .rpc('get_ride_party_profiles', { p_ride_id: rideId })
      .maybeSingle<{
        rider_name: string;
        rider_avatar_url: string | null;
        rider_rating: number;
      }>();

    return {
      ...rideData,
      rider_name: parties?.rider_name ?? 'Pasajero',
      rider_avatar_url: parties?.rider_avatar_url ?? null,
      rider_rating: parties?.rider_rating ?? 5.0,
    };
  },

  /**
   * Get the active ride for the current user (if any).
   */
  /**
   * BUG-244: rider confirms driver arrived (used when GPS gate fired).
   * Called from the "Tu conductor llegó? [Sí]" prompt.
   */
  async riderConfirmDriverArrival(rideId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('rider_confirm_driver_arrival', {
      p_ride_id: rideId,
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
  },

  /**
   * BUG-246: rider responds to driver's "GPS unavailable" notification.
   * consent=true → ride continues without GPS proximity gates.
   * consent=false → ride is canceled without penalty for either party.
   */
  async riderRespondToGpsUnavailable(rideId: string, consent: boolean): Promise<{ canceled?: boolean }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('rider_respond_to_gps_unavailable', {
      p_ride_id: rideId,
      p_consent: consent,
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
    return data as { canceled?: boolean };
  },

  async getActiveRide(userId: string): Promise<Ride | null> {
    const supabase = getSupabaseClient();
    // UX: `arrived_at_destination` was missing — if the driver tapped
    // "Llegué al destino" and the client reloaded during that window, the
    // client lost the ride and had to start from the home screen. The
    // transition is brief but real (driver may take ~30s to tap Finalizar
    // afterwards), and refresh/reconnect during it was a dead end.
    const activeStatuses: RideStatus[] = [
      'searching', 'accepted', 'driver_en_route',
      'arrived_at_pickup', 'in_progress', 'arrived_at_destination',
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
    if (!data) return null;
    // BUG-228: transform PostGIS geometry into the GeoPoint shape the rest
    // of the app expects (pickup_location: { latitude, longitude }). Without
    // this, the raw EWKB hex string was being read as `pickup_location` and
    // `.latitude` returned undefined → markers rendered at (0,0) or random
    // garbage coords.
    const ride = data as Record<string, unknown>;
    return {
      ...(ride as unknown as Ride),
      pickup_location: {
        latitude: (ride.pickup_lat as number) ?? 0,
        longitude: (ride.pickup_lng as number) ?? 0,
      },
      dropoff_location: {
        latitude: (ride.dropoff_lat as number) ?? 0,
        longitude: (ride.dropoff_lng as number) ?? 0,
      },
    };
  },

  /**
   * Cancel a ride. Delegates everything (auth check, row lock, fee
   * calculation, penalty progression, offer supersession) to the
   * `cancel_ride` SECURITY DEFINER RPC. The `userId` parameter is
   * retained for backwards compatibility but IGNORED on the server —
   * `canceled_by` is derived from `auth.uid()`. See migration 00121.
   */
  async cancelRide(
    rideId: string,
    _userId?: string,
    reason?: string,
  ): Promise<{
    penaltyAmount: number;
    isBlocked: boolean;
    cancellationFee?: CancellationFeePreview;
  } | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc('cancel_ride', {
      p_ride_id: rideId,
      p_reason: reason ?? null,
    });
    if (error) throw error;

    const result = data as {
      success?: boolean;
      error?: string;
      fee_cup?: number;
      fee_trc?: number;
      fee_reason?: string;
      penalty_amount?: number;
      is_blocked?: boolean;
    } | null;

    if (!result || result.error) {
      const code = result?.error ?? 'unknown';
      if (code === 'unauthorized') {
        throw new ForbiddenError('User is not the customer or driver of this ride');
      }
      throw new Error(`cancel_ride failed: ${code}`);
    }

    const feeCup = result.fee_cup ?? 0;
    const cancellationFee: CancellationFeePreview = {
      fee_cup: feeCup,
      fee_trc: result.fee_trc ?? 0,
      fee_reason: result.fee_reason ?? 'free_cancel',
      is_free: feeCup === 0,
    };

    return {
      penaltyAmount: result.penalty_amount ?? 0,
      isBlocked: result.is_blocked ?? false,
      cancellationFee,
    };
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
   * Get all rides currently offered to the authenticated driver
   * (pending offers that haven't expired). Replaces the legacy
   * `getSearchingRides` broadcast. RLS ensures drivers only see their
   * own offers (see migration 00120).
   *
   * Returns the joined `rides` rows with each offer's expires_at so
   * the UI can show remaining-time for the offer window.
   */
  async getSearchingRides(): Promise<Ride[]> {
    const supabase = getSupabaseClient();
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from('ride_offers')
      .select('expires_at, rides!inner(*)')
      .eq('status', 'pending')
      .gt('expires_at', nowIso)
      .order('offered_at', { ascending: false });
    if (error) throw error;
    // Flatten: ride_offers → nested rides row
    type OfferRow = { expires_at: string; rides: Ride };
    return ((data as unknown as OfferRow[]) ?? []).map((row) => ({
      ...row.rides,
      offer_expires_at: row.expires_at,
    })) as Ride[];
  },

  /**
   * Subscribe to ride status changes (Postgres Changes).
   *
   * BUG-214 (mapa driver vacío + cliente sigue buscando):
   * `payload.new` from `postgres_changes` contains the raw Postgres row,
   * including `pickup_location` / `dropoff_location` as PostGIS geometry
   * (WKT/EWKB). The driver's `useRoutePolyline` (and any UI reading
   * `.pickup_location.latitude`) expects `{ latitude, longitude }`. Without
   * this transform, every realtime UPDATE clobbered the previously-fetched
   * `transformRideCoordinates`-produced shape with raw geometry — markers
   * and polyline disappeared from the driver map immediately after accept.
   *
   * We also log subscription status so we can see in the device console
   * whether the channel actually subscribed, and whether updates fire.
   * (Bug 5: cliente sigue buscando — silent subscription failure was the
   * leading hypothesis; the log will confirm or rule it out at runtime.)
   */
  /**
   * BUG-277 — Realtime DISABLED. Returns a no-op subscription.
   *
   * Forensic evidence (Supabase logs 2026-04-28 02:38–02:39):
   * driver upload gaps of 47.9s, 23.2s, 9.0s, 8.0s, 6.7s on a 810 Mbps
   * fiber WiFi 6 link with 30ms ping and 0% loss. Server logs show 0
   * 5xx and 100% success on the POSTs that arrived. The driver's
   * fetch() POSTs were not arriving at the server during the gaps.
   *
   * Root cause: OkHttp `maxRequestsPerHost = 5` (RN Android default).
   * WebSocket realtime channels (this `subscribeToRide` + the one in
   * `useDriverPosition`) hold connection slots indefinitely. With
   * heartbeat + update_driver_position + driver_profiles GET + rides
   * GET + buffer flush running in parallel, the pool saturates.
   *
   * Fix: remove the WebSocket entirely. Polling already covers ride
   * status updates via `useRideInit`'s 3-second watcher and the
   * `getActiveRide` checks. Freeing a slot per ride immediately
   * reduces concurrent request pressure on the OkHttp dispatcher.
   *
   * If realtime is ever re-enabled, restore from git history.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  subscribeToRide(_rideId: string, _onUpdate: (ride: Ride) => void) {
    return {
      unsubscribe: () => { /* no-op — realtime disabled per BUG-277 */ },
    };
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

    // Calculate discount. `bonus_credit` is a percentage-discount sibling
    // (same mechanics as percentage_discount, different UI label — e.g.
    // welcome bonus or loyalty promo). Kept in sync with the DB trigger
    // in supabase/migrations/00175_bonus_credit_is_percentage_discount.
    let discountAmount = 0;
    if (
      (promotion.type === 'percentage_discount' || promotion.type === 'bonus_credit') &&
      promotion.discount_percent
    ) {
      discountAmount = Math.min(
        Math.round(params.fareAmount * promotion.discount_percent / 100),
        params.fareAmount, // Cap at 100% of fare
      );
    } else if (promotion.type === 'fixed_discount' && promotion.discount_fixed_cup) {
      discountAmount = Math.min(promotion.discount_fixed_cup, params.fareAmount);
    }

    return { valid: true, promotion, discountAmount };
  },

  /**
   * Subscribe to new ride OFFERS for the authenticated driver.
   * Replaces the legacy broadcast subscription to `rides:searching`.
   *
   * RLS filters on `ride_offers` ensure the driver only receives
   * offers targeted at them (see migration 00120). On INSERT we fetch
   * the full ride row (which the driver can now SELECT via the
   * updated r_select_driver policy). On UPDATE we notify the caller
   * so expired/superseded offers can be removed from UI.
   */
  subscribeToNewRides(
    onInsert: (ride: Ride) => void,
    onUpdate: (ride: Ride) => void,
  ) {
    const supabase = getSupabaseClient();
    return supabase
      .channel('ride_offers:mine')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'ride_offers',
        },
        async (payload) => {
          const offer = payload.new as { ride_id: string; expires_at: string; status: string };
          if (offer.status !== 'pending') return;
          const { data: ride, error } = await supabase
            .from('rides')
            .select('*')
            .eq('id', offer.ride_id)
            .maybeSingle();
          if (error || !ride) return;
          onInsert({ ...(ride as Ride), offer_expires_at: offer.expires_at } as Ride);
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'ride_offers',
        },
        async (payload) => {
          const offer = payload.new as { ride_id: string; status: string };
          // Any offer leaving 'pending' means the ride is no longer
          // available to this driver — fetch minimal info to let UI remove it.
          if (offer.status === 'pending') return;
          onUpdate({ id: offer.ride_id, status: offer.status === 'accepted' ? 'accepted' : 'canceled' } as unknown as Ride);
        },
      )
      .subscribe();
  },

  // ==================== PUBLIC / SHARE TOKEN ====================

  /**
   * Get a ride by its public share token (no auth required).
   * Returns full RideWithDriver — use getPublicRideByShareToken() for
   * unauthenticated consumers (web tracking page) to avoid leaking
   * private fields like driver phone, fare amounts, and addresses.
   * @deprecated Use getPublicRideByShareToken() for public endpoints.
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

    return this.getRideWithDriver((ride as Ride).id);
  },

  /**
   * Privacy-safe public lookup by share token.
   * Returns only fields safe for unauthenticated viewers:
   * - Status, coordinates (NOT addresses), timing
   * - Driver first name, avatar, rating, vehicle info
   * - NO: phone, fare, payment, promo, customer_id
   *
   * Also enforces token expiration (24h after completion).
   */
  async getPublicRideByShareToken(token: string): Promise<SharedRideView | null> {
    const supabase = getSupabaseClient();

    // BUG-118 fix: rides + driver_profiles + users + vehicles all have
    // RLS scoped to ride participants, so anonymous viewers (trusted
    // contacts opening the SMS link, web visitors not signed in) used
    // to receive empty rows from each direct table query. Now we go
    // through a single SECURITY DEFINER RPC that bundles the
    // privacy-safe fields and enforces share_token expiry inline.
    const { data, error } = await supabase
      .rpc('get_shared_ride_by_token', { p_token: token });
    if (error) throw error;
    const row = (data && data[0]) as Record<string, unknown> | undefined;
    if (!row) return null;

    // Waypoints come from a sibling SECURITY DEFINER RPC.
    const { data: waypointsData } = await supabase
      .rpc('get_ride_waypoints_by_share_token', { p_token: token });
    const waypoints = (waypointsData ?? []).map(
      (w: { id: string; sort_order: number; latitude: number; longitude: number; arrived_at: string | null; departed_at: string | null }) => ({
        id: w.id,
        sort_order: w.sort_order,
        latitude: w.latitude,
        longitude: w.longitude,
        arrived_at: w.arrived_at,
        departed_at: w.departed_at,
      }),
    );

    const result: SharedRideView = {
      id: row.id as string,
      status: row.status as SharedRideView['status'],
      service_type: row.service_type as SharedRideView['service_type'],
      pickup_location: { latitude: (row.pickup_lat as number) ?? 0, longitude: (row.pickup_lng as number) ?? 0 },
      dropoff_location: { latitude: (row.dropoff_lat as number) ?? 0, longitude: (row.dropoff_lng as number) ?? 0 },
      pickup_address: (row.pickup_address as string | null) ?? null,
      dropoff_address: (row.dropoff_address as string | null) ?? null,
      estimated_duration_s: (row.estimated_duration_s as number) ?? 0,
      accepted_at: (row.accepted_at as string | null) ?? null,
      pickup_at: (row.pickup_at as string | null) ?? null,
      arrived_at_destination_at: (row.arrived_at_destination_at as string | null) ?? null,
      completed_at: (row.completed_at as string | null) ?? null,
      canceled_at: (row.canceled_at as string | null) ?? null,
      driver_first_name: (row.driver_first_name as string | null) ?? null,
      driver_avatar_url: (row.driver_avatar_url as string | null) ?? null,
      driver_rating: (row.driver_rating as number | null) ?? null,
      vehicle_make: (row.vehicle_make as string | null) ?? null,
      vehicle_model: (row.vehicle_model as string | null) ?? null,
      vehicle_color: (row.vehicle_color as string | null) ?? null,
      vehicle_plate: (row.vehicle_plate as string | null) ?? null,
      vehicle_photo_url: (row.vehicle_photo_url as string | null) ?? null,
      vehicle_type: (row.vehicle_type as string | null) ?? null,
      waypoints,
    };

    // Driver + vehicle fields come straight from get_shared_ride_by_token's
    // joined SELECT — no follow-up fetches needed. Saves the previous
    // N+1 round-trip pattern.

    return result;
  },

  /**
   * Bug A — poll endpoint for the public share-tracking page.
   *
   * Returns the LIVE slice of a shared ride: status + the latest driver
   * GPS sample. The static info (driver name, vehicle, route endpoints,
   * addresses) is fetched once via getPublicRideByShareToken(); this is
   * the small payload the page polls every few seconds.
   *
   * Why polling and not realtime: the driver's GPS loop writes
   * ride_location_events via the update_driver_position RPC and emits
   * NO broadcast (BUG-275). Realtime channels were also removed app-wide
   * (BUG-277). Polling a SECURITY DEFINER RPC is the canonical path —
   * works for anonymous viewers, zero extra load on the driver.
   *
   * Tolerates the RPC being absent (migration 00268 not yet applied):
   * returns null so the page keeps its last known state, no crash.
   */
  async getSharedTripState(token: string): Promise<SharedTripState | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_shared_trip_state', { p_token: token });
    if (error) {
      // 42883 = undefined_function — migration 00268 not applied to prod.
      if (
        error.code === '42883' ||
        error.message?.toLowerCase().includes('does not exist')
      ) {
        return null;
      }
      throw error;
    }
    const row = (data && data[0]) as Record<string, unknown> | undefined;
    if (!row) return null;

    const lat = row.driver_lat as number | null;
    const lng = row.driver_lng as number | null;
    return {
      status: row.status as SharedTripState['status'],
      accepted_at: (row.accepted_at as string | null) ?? null,
      pickup_at: (row.pickup_at as string | null) ?? null,
      arrived_at_destination_at: (row.arrived_at_destination_at as string | null) ?? null,
      completed_at: (row.completed_at as string | null) ?? null,
      canceled_at: (row.canceled_at as string | null) ?? null,
      driver_location:
        lat != null && lng != null ? { latitude: lat, longitude: lng } : null,
      driver_heading: (row.driver_heading as number | null) ?? null,
      driver_recorded_at: (row.driver_recorded_at as string | null) ?? null,
    };
  },

  /**
   * Revoke sharing — sets share_token to null.
   * Only the ride's customer can revoke.
   */
  async revokeShareToken(rideId: string, userId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('rides')
      .update({ share_token: null, share_token_expires_at: null })
      .eq('id', rideId)
      .eq('customer_id', userId);
    if (error) throw error;
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
    // Generate 24-char hex token using cryptographically secure RNG
    const array = new Uint8Array(12);
    crypto.getRandomValues(array);
    const token = Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
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
   * Fetch aggregate offer stats for a ride the caller owns (rider side).
   * Returns driver counts and dispatch-round info, NOT individual driver
   * identities. See migration 00127.
   */
  async getRideOfferStats(rideId: string): Promise<RideOfferStats | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_ride_offer_stats', {
      p_ride_id: rideId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return {
      pending_count: row.pending_count ?? 0,
      accepted_count: row.accepted_count ?? 0,
      expired_count: row.expired_count ?? 0,
      earliest_expires_at: row.earliest_expires_at ?? null,
      last_dispatched_at: row.last_dispatched_at ?? null,
      dispatch_round: row.dispatch_round ?? 0,
    };
  },

  /**
   * Fetch up to 8 demand hotspots around a point. Combines a 28-day
   * historical pattern (matching the current hour-of-week) with a
   * live boost from `status='searching'` rides in the last 10 min.
   * See migration 00125. Returned intensity is normalized 0..1.
   */
  async getDemandHotspots(params: {
    lat: number;
    lng: number;
    radiusM?: number;
  }): Promise<DemandHotspot[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_demand_hotspots', {
      p_lat: params.lat,
      p_lng: params.lng,
      p_radius_m: params.radiusM ?? 5000,
    });
    if (error) throw error;
    return (data as DemandHotspot[] | null) ?? [];
  },

  /**
   * Fetch popular pickup/dropoff clusters around a point. Sourced
   * from the `popular_locations` materialized view (migration 00083),
   * which aggregates the last 90 days of completed rides via
   * ST_ClusterDBSCAN. Refreshed daily at 04:00 UTC. Different
   * semantics from `getDemandHotspots`: that one combines a live
   * boost with the matching hour-of-week pattern; this one is the
   * pure historical "where do trips usually start/end" view.
   */
  async getPopularLocations(params: {
    lat: number;
    lng: number;
    radiusM?: number;
    limit?: number;
  }): Promise<PopularLocation[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_popular_locations', {
      p_lat: params.lat,
      p_lng: params.lng,
      p_radius_m: params.radiusM ?? 5000,
      p_limit: params.limit ?? 20,
    });
    if (error) throw error;
    return (data as PopularLocation[] | null) ?? [];
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
   * Estimate the fare/distance delta of inserting a new waypoint into
   * an active ride. Purely a preview — does not mutate the ride.
   *
   * Uses haversine legs against the ride's pickup/dropoff and any
   * existing waypoints; the per-km rate comes from service_type_configs
   * (same source as getLocalFareEstimate). No network route is fetched
   * to keep the preview fast; the real route recalc happens after the
   * waypoint lands and Mapbox re-runs the directions.
   *
   * I3 ride-flow review: drivers and riders need to see the incremental
   * cost before committing the stop.
   */
  async estimateWaypointAddition(
    rideId: string,
    latitude: number,
    longitude: number,
    /**
     * Existing waypoint coords (in visit order) that the caller has in
     * local state. We use the last one — if empty, we fall back to the
     * ride's pickup coords. Passed in rather than re-fetched to avoid
     * having to parse PostGIS GEOGRAPHY on the client.
     */
    existingWaypointsLatLng: Array<{ latitude: number; longitude: number }> = [],
  ): Promise<{ extraDistanceKm: number; extraFareCup: number }> {
    const supabase = getSupabaseClient();

    const { data: ride, error: rideErr } = await supabase
      .from('rides')
      .select('service_type, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng')
      .eq('id', rideId)
      .maybeSingle();
    if (rideErr) throw rideErr;
    if (!ride) throw new Error('Ride not found');

    const lastStop = existingWaypointsLatLng.length > 0
      ? existingWaypointsLatLng[existingWaypointsLatLng.length - 1]!
      : { latitude: ride.pickup_lat as number, longitude: ride.pickup_lng as number };

    const dropoff = {
      latitude: ride.dropoff_lat as number,
      longitude: ride.dropoff_lng as number,
    };
    const newStop = { latitude, longitude };

    // Extra haversine distance = (last→new) + (new→dropoff) − (last→dropoff)
    const oldLegM = haversineDistance(lastStop, dropoff);
    const newLegM =
      haversineDistance(lastStop, newStop) +
      haversineDistance(newStop, dropoff);
    const extraStraightM = Math.max(0, newLegM - oldLegM);
    const extraRoadM = estimateRoadDistance(extraStraightM);
    const extraDistanceKm = Math.round((extraRoadM / 1000) * 100) / 100;

    // Pull the per-km rate for this service so we can price the detour.
    const { data: svc } = await supabase
      .from('service_type_configs')
      .select('per_km_rate_cup')
      .eq('slug', ride.service_type)
      .eq('is_active', true)
      .maybeSingle();

    const perKm = (svc?.per_km_rate_cup as number | undefined) ?? 0;
    const extraFareCup = Math.round((extraRoadM / 1000) * perKm);

    return { extraDistanceKm, extraFareCup };
  },

  /**
   * Add a waypoint to an active ride (max 3 waypoints).
   */
  async addWaypointToActiveRide(
    rideId: string,
    address: string,
    latitude: number,
    longitude: number,
  ): Promise<Waypoint> {
    const supabase = getSupabaseClient();
    // Get current max sort_order
    const { data: existing } = await supabase
      .from('ride_waypoints')
      .select('sort_order')
      .eq('ride_id', rideId)
      .order('sort_order', { ascending: false })
      .limit(1);
    const nextOrder = (existing?.[0]?.sort_order ?? 0) + 1;
    if (nextOrder > 3) throw new ValidationError('MAX_WAYPOINTS_REACHED');
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
    return data as Waypoint;
  },

  /**
   * Get waypoints for a ride.
   */
  async getRideWaypoints(rideId: string): Promise<Waypoint[]> {
    const supabase = getSupabaseClient();
    // Use RPC so we get numeric latitude/longitude columns. Raw
    // `.select('*')` would return the GEOGRAPHY `location` as an
    // opaque WKB hex the JS client can't read, leaving lat/lng
    // undefined on the waypoints state — which is why the route
    // polyline never included the stops in the map.
    const { data, error } = await supabase
      .rpc('get_ride_waypoints_with_coords', { p_ride_id: rideId });
    if (error) throw error;
    return (data ?? []) as Waypoint[];
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
    onInsert: (wp: Record<string, unknown>) => void,
    onUpdate: (wp: Record<string, unknown>) => void,
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
  ): Promise<RideSplit> {
    const supabase = getSupabaseClient();

    // Validate payment method is tricicoin
    const { data: ride } = await supabase
      .from('rides')
      .select('payment_method, is_split')
      .eq('id', rideId)
      .single();
    if (ride?.payment_method !== 'tricicoin') {
      throw new ValidationError('SPLIT_ONLY_TRICICOIN');
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
    return data as RideSplit;
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
  async getSplitsForRide(rideId: string): Promise<RideSplit[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_splits')
      .select('*, users:user_id(raw_user_meta_data)')
      .eq('ride_id', rideId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map((s) => ({
      ...(s as Record<string, unknown>),
      user_name: (s as Record<string, unknown> & { users?: { raw_user_meta_data?: { name?: string; phone?: string } } }).users?.raw_user_meta_data?.name ?? null,
      user_phone: (s as Record<string, unknown> & { users?: { raw_user_meta_data?: { name?: string; phone?: string } } }).users?.raw_user_meta_data?.phone ?? null,
      users: undefined,
    })) as unknown as RideSplit[];
  },

  /**
   * Get pending split invites for a user.
   */
  async getMySplitInvites(userId: string): Promise<RideSplit[]> {
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
    onInsert: (split: Record<string, unknown>) => void,
    onUpdate: (split: Record<string, unknown>) => void,
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

  /**
   * Build the data shape consumed by `generateReceiptHTML` for a single
   * completed ride. Pulls the final pricing snapshot + the
   * counterparty's name in a single round-trip per side, plus a small
   * shared ride lookup for the addresses, payment method and dates.
   *
   * Both passenger and driver receipts read from the same underlying
   * pricing snapshot — the variant only changes which fields end up
   * in the final payload.
   */
  async getReceiptData(
    rideId: string,
    variant: 'passenger' | 'driver',
  ): Promise<import('@tricigo/utils').ReceiptData> {
    const supabase = getSupabaseClient();

    const { data: _rideRaw, error: rideErr } = await supabase
      .from('rides')
      .select(
        'id, customer_id, driver_id, service_type, payment_method, ' +
        'pickup_address, dropoff_address, ' +
        'final_fare_cup, estimated_fare_cup, final_fare_trc, estimated_fare_trc, ' +
        'discount_amount_cup, surge_multiplier, tip_amount, exchange_rate_usd_cup, ' +
        'actual_distance_m, estimated_distance_m, actual_duration_s, estimated_duration_s, ' +
        'completed_at, created_at',
      )
      .eq('id', rideId)
      .single();
    if (rideErr) throw rideErr;
    if (!_rideRaw) throw new Error('RIDE_NOT_FOUND');
    const ride = _rideRaw as unknown as Record<string, unknown>;

    const { data: snap } = await supabase
      .from('ride_pricing_snapshots')
      .select('base_fare, subtotal, commission_rate, commission_amount, total, surge_multiplier')
      .eq('ride_id', rideId)
      .eq('snapshot_type', 'final')
      .maybeSingle();

    const dateISO = (ride.completed_at as string | null) ?? (ride.created_at as string);
    const { deriveReceiptNo } = await import('@tricigo/utils');
    const receiptNo = deriveReceiptNo(ride.id as string, dateISO);

    const distanceM = (ride.actual_distance_m as number | null) ?? (ride.estimated_distance_m as number) ?? 0;
    const durationS = (ride.actual_duration_s as number | null) ?? (ride.estimated_duration_s as number) ?? 0;
    const totalCup = (ride.final_fare_cup as number | null) ?? (ride.estimated_fare_cup as number);
    const subtotalCup = (snap?.subtotal as number | null) ?? totalCup;
    const surgeMult = Number(snap?.surge_multiplier ?? ride.surge_multiplier ?? 1);
    const surgeAmountCup = surgeMult > 1 ? Math.max(0, Math.round(subtotalCup * (surgeMult - 1))) : 0;
    const exchangeRateUsdCup = ride.exchange_rate_usd_cup != null ? Number(ride.exchange_rate_usd_cup) : null;

    const base = {
      receiptNo,
      rideId: ride.id as string,
      date: dateISO,
      pickupAddress: ride.pickup_address as string,
      dropoffAddress: ride.dropoff_address as string,
      serviceType: ride.service_type as string,
      distanceM,
      durationS,
      paymentMethod: ride.payment_method as string,
      exchangeRateUsdCup,
    };

    if (variant === 'passenger') {
      const { data: driverProfile } = ride.driver_id
        ? await supabase
            .from('driver_profiles')
            .select('user_id, vehicles(plate_number)')
            .eq('id', ride.driver_id as string)
            .maybeSingle()
        : { data: null };
      const driverUserId = (driverProfile?.user_id as string | undefined) ?? null;
      const { data: driverUser } = driverUserId
        ? await supabase.from('users').select('full_name').eq('id', driverUserId).maybeSingle()
        : { data: null };
      const vehicleArr = driverProfile?.vehicles as { plate_number: string }[] | { plate_number: string } | null | undefined;
      const vehiclePlate = Array.isArray(vehicleArr) ? vehicleArr[0]?.plate_number ?? null : vehicleArr?.plate_number ?? null;

      return {
        variant: 'passenger',
        ...base,
        driverName: (driverUser?.full_name as string | null) ?? null,
        vehiclePlate,
        subtotalCup,
        surgeMultiplier: surgeMult,
        surgeAmountCup,
        discountCup: (ride.discount_amount_cup as number | null) ?? 0,
        tipCup: (ride.tip_amount as number | null) ?? 0,
        totalCup,
        fareTrc: (ride.final_fare_trc as number | null) ?? (ride.estimated_fare_trc as number | null) ?? null,
      };
    }

    // driver variant
    const { data: passengerUser } = await supabase
      .from('users')
      .select('full_name')
      .eq('id', ride.customer_id as string)
      .maybeSingle();
    const grossFareCup = totalCup;
    const commissionRate = Number(snap?.commission_rate ?? 0);
    const commissionCup = (snap?.commission_amount as number | null) ?? Math.round(grossFareCup * commissionRate);
    const tipCup = (ride.tip_amount as number | null) ?? 0;
    const netCup = grossFareCup - commissionCup + tipCup;

    return {
      variant: 'driver',
      ...base,
      passengerName: (passengerUser?.full_name as string | null) ?? null,
      grossFareCup,
      commissionRate,
      commissionCup,
      tipCup,
      netCup,
    };
  },
};
