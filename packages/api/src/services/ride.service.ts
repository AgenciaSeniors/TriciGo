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
  SurgeType,
  DemandHotspot,
  PopularLocation,
  RideOfferStats,
  TripInsuranceConfig,
  RidePreferences,
  CancellationRatingImpact,
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
import { realtimeStatusLogger } from './_realtime-status';
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
  /** Breakdown que vio el rider al confirmar el viaje. Si se proveen,
   *  `createRide` persiste un `ride_pricing_snapshots` row con
   *  `snapshot_type='estimate'` y `complete_ride_and_pay` los usa al
   *  cobrar (parity surge + pricing_rule_id + rates). Si no, el RPC cae
   *  a `service_type_configs` defaults (comportamiento actual). */
  base_fare_cup?: number;
  per_km_rate_cup?: number;
  per_minute_rate_cup?: number;
  min_fare_cup?: number;
  surge_multiplier?: number;
  pricing_rule_id?: string;
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
  /** "Compartir viaje": rider allows the driver to fill empty seats. */
  share_ride?: boolean;
  /** Seats the rider occupies (incl. themselves); drives the free-seat discount. */
  declared_passengers?: number;
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
    // Weather surge is global (city-wide), so one shared key dedupes the call
    // across all concurrent per-service-type estimates.
    const surgeKey = 'weather_surge';
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
          Promise.resolve(supabase.rpc('get_weather_surge')).catch(() => {
            console.warn('[ride.service] Weather surge RPC failed, falling back to multiplier 1.0');
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

    // ─── Weather surge (global, the only surge left) ───
    // Bad weather (rain / storm / extreme / cold front) is the sole factor that
    // can raise fares. Zone-based and demand-based surge were removed.
    let surgeMultiplier = 1.0;
    let surgeType: SurgeType = 'none';
    const surgeData = surgeResult?.data;
    if (typeof surgeData === 'number' && surgeData > 1.0) {
      surgeMultiplier = surgeData;
      surgeType = 'weather';
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
      // BUG-fare-audit-followup Cambio 3: exponer el min_fare efectivo
      // (puede venir de la pricing rule o del service default) para que
      // el client lo pase a createRide y el RPC lo use como floor.
      min_fare_cup: minFare,
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
        // BUG-fare-audit L2: surge snapshoteado al crear el ride en vez
        // del fetch live que hacía `complete_ride_and_pay`. Si el rider
        // confirma con surge 1.2× y la zona sale de surge mid-viaje, el
        // final cobra el 1.2× que se prometió, no el 1.0× live.
        surge_multiplier: validParams.surge_multiplier ?? 1,
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
        // Shared-ride opt-in + declared seats. The discount itself is
        // computed server-side by the rides_validate_promo_discount
        // trigger (00347) — never trusted from the client.
        shared_ride: validParams.share_ride ?? false,
        shared_ride_seats_occupied: validParams.share_ride ? (validParams.declared_passengers ?? 1) : null,
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

    // P-CRIT-1/P-HIGH-4 (migration 00320): el trigger BEFORE INSERT en
    // `rides` (`tg_rides_validate_promo_discount`) ahora hace el dedupe
    // per-user + claim atómico del slot. Post-migración:
    //   * INSERT en promotion_uses falla con código 23505 (UNIQUE) —
    //     silently ignored porque el trigger ya lo insertó.
    //   * `increment_promo_uses` es un no-op (kept para compat backward).
    //   * NO rollback on catch — eso borraría el row del trigger y dejaría
    //     a current_uses incrementado sin marker → drift.
    // Pre-migración (deploy gap): el código sigue funcionando como antes.
    if (validParams.promo_code_id && data) {
      const { error: puErr } = await supabase.from('promotion_uses').insert({
        promotion_id: validParams.promo_code_id,
        user_id: user.id,
        ride_id: (data as Ride).id,
      });
      if (puErr && puErr.code !== '23505') {
        // Real error, not the expected post-migration UNIQUE conflict.
        logger.warn('promo_use_insert_unexpected_error', {
          rideId: (data as Ride).id,
          error: puErr.message,
        });
      }
      const { error: incErr } = await supabase.rpc('increment_promo_uses', {
        p_promo_id: validParams.promo_code_id,
      });
      if (incErr) {
        logger.warn('increment_promo_uses_failed', { error: incErr.message });
      }
    }

    // Insert waypoints if provided
    const rideData = data as Ride;

    // BUG-fare-audit B1: persistir el breakdown del estimate como snapshot
    // canónico. `complete_ride_and_pay` lo lee al cobrar (via
    // `ride_pricing_snapshots` WHERE snapshot_type='estimate') para que el
    // final use exactamente los rates que el rider vio (incluye surge,
    // pricing_rule_id y per_km/per_min). Evita que cambios futuros de
    // pricing_rules o platform_config retroactive a este ride. Best-effort:
    // si falla, el RPC cae al fallback service_type_configs.
    const hasEstimateBreakdown =
      validParams.base_fare_cup != null &&
      validParams.per_km_rate_cup != null &&
      validParams.per_minute_rate_cup != null;
    if (hasEstimateBreakdown) {
      try {
        const subtotalEstimate = validParams.estimated_fare_cup ?? 0;
        const surgeMult = validParams.surge_multiplier ?? 1;

        // BUG-fare-audit-followup Cambio 2: leer commission_rate del
        // platform_config en lugar de hardcodear 0.15. Si el default
        // cambia entre el pedido y el completion, el snapshot ahora
        // captura el valor real del momento — la migración 00283 lo lee
        // en `complete_ride_and_pay`. Best-effort: si falla, queda 0.15.
        let commissionRate = 0.15;
        try {
          const { data: cfg } = await supabase
            .from('platform_config')
            .select('value')
            .eq('key', 'commission_rate')
            .maybeSingle();
          const raw = cfg?.value;
          const parsed = raw != null ? parseFloat(String(raw).replace(/"/g, '')) : NaN;
          if (!isNaN(parsed) && parsed > 0 && parsed < 1) commissionRate = parsed;
        } catch { /* best-effort: queda 0.15 */ }

        // BUG-fare-audit-followup Cambio 4: snapshotear la commission_rate
        // del corporate account (si aplica). Acompañada del default
        // platform en `default_commission_rate_snapshot` para que la
        // lógica del 00236 (corporate override) sea estable ante cambios
        // mid-trip. Si el ride no es corporate, queda null.
        let corporateCommissionRate: number | null = null;
        if (validParams.corporate_account_id) {
          try {
            const { data: corp } = await supabase
              .from('corporate_accounts')
              .select('commission_percent')
              .eq('id', validParams.corporate_account_id)
              .maybeSingle();
            const pct = (corp as { commission_percent?: number | string } | null)?.commission_percent;
            if (pct != null) {
              const parsed = typeof pct === 'string' ? parseFloat(pct) : pct;
              if (!isNaN(parsed) && parsed > 0 && parsed < 100) {
                corporateCommissionRate = parsed / 100;
              }
            }
          } catch { /* best-effort: queda null, RPC lee live */ }
        }

        const commissionAmount = Math.round(subtotalEstimate * commissionRate);
        // BUG-fare-audit-followup Cambio 3+4: agregar min_fare,
        // corporate_commission_rate, default_commission_rate_snapshot al
        // INSERT. Estas columnas las agrega la migración 00283; si todavía
        // no se aplicó en prod, el INSERT falla con "columna desconocida"
        // y el catch externo deja todo en best-effort (sin romper el ride).
        await supabase.from('ride_pricing_snapshots').insert({
          ride_id: rideData.id,
          snapshot_type: 'estimate',
          base_fare: validParams.base_fare_cup,
          per_km_rate: validParams.per_km_rate_cup,
          per_minute_rate: validParams.per_minute_rate_cup,
          min_fare: validParams.min_fare_cup ?? null,
          distance_m: validParams.estimated_distance_m ?? 0,
          duration_s: validParams.estimated_duration_s ?? 0,
          surge_multiplier: surgeMult,
          subtotal: subtotalEstimate,
          commission_rate: commissionRate,
          commission_amount: commissionAmount,
          total: subtotalEstimate,
          pricing_rule_id: validParams.pricing_rule_id || null,
          exchange_rate_usd_cup: exchangeRate,
          corporate_commission_rate: corporateCommissionRate,
          default_commission_rate_snapshot: commissionRate,
        });
      } catch (snapErr) {
        // Best-effort: snapshot failure does not block the ride. The RPC
        // will fall back to service_type_configs / live commission rates
        // at completion (mismo comportamiento que pre-PR #147).
        logger.warn('estimate_snapshot_insert_failed', {
          rideId: rideData.id,
          error: (snapErr as Error).message,
        });
      }
    }

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
   * Cancel a ride. Delegates everything (auth check, row lock,
   * reputation eligibility, offer supersession) to the `cancel_ride`
   * SECURITY DEFINER RPC. The `userId` parameter is retained for
   * backwards compatibility but IGNORED on the server — `canceled_by`
   * is derived from `auth.uid()`. See migrations 00121 / 00371.
   *
   * Cancelling no longer charges money: a late cancellation lowers the
   * canceller's visible star rating instead (returned as `ratingImpact`).
   */
  async cancelRide(
    rideId: string,
    _userId?: string,
    reason?: string,
  ): Promise<{ ratingImpact: CancellationRatingImpact } | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc('cancel_ride', {
      p_ride_id: rideId,
      p_reason: reason ?? null,
    });
    if (error) throw error;

    const result = data as {
      success?: boolean;
      error?: string;
      rating_penalized?: boolean;
      is_grace?: boolean;
      cancel_count_24h?: number;
      rating_value?: number | null;
      stars_before?: number | null;
      stars_after?: number | null;
    } | null;

    if (!result || result.error) {
      const code = result?.error ?? 'unknown';
      if (code === 'unauthorized') {
        throw new ForbiddenError('User is not the customer or driver of this ride');
      }
      throw new Error(`cancel_ride failed: ${code}`);
    }

    const ratingImpact: CancellationRatingImpact = {
      rating_penalized: result.rating_penalized ?? false,
      is_grace: result.is_grace ?? true,
      cancel_count_24h: result.cancel_count_24h ?? 0,
      rating_value: result.rating_value ?? null,
      stars_before: result.stars_before ?? null,
      stars_after: result.stars_after ?? null,
    };

    return { ratingImpact };
  },

  /**
   * Rider heartbeat for a searching ride (persistent search). The client
   * calls this every ~30s while on the "searching" screen so the server
   * knows the rider is still waiting — `cleanup_orphan_searching_rides`
   * only cancels rides whose heartbeat went stale (abandoned app).
   *
   * Fully best-effort: a missed beat is harmless (the next one retries
   * 30s later) and the RPC may be absent if migration 00269 hasn't
   * reached prod yet. All errors are swallowed.
   */
  async touchSearchingRide(rideId: string): Promise<void> {
    try {
      const supabase = getSupabaseClient();
      await supabase.rpc('touch_searching_ride', { p_ride_id: rideId });
    } catch {
      /* best-effort heartbeat — ignore */
    }
  },

  /**
   * Preview the RATING impact of cancelling now (without applying it).
   * Shows the user exactly how their visible stars would move before
   * confirming. Tolerates the RPC being absent (migration 00371 not yet
   * applied) by returning a grace / no-impact default — never throws.
   */
  async previewCancellationImpact(rideId: string): Promise<CancellationRatingImpact> {
    const fallback: CancellationRatingImpact = {
      rating_penalized: false,
      is_grace: true,
      cancel_count_24h: 0,
      rating_value: null,
      stars_before: null,
      stars_after: null,
    };
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.rpc('preview_cancellation_rating_impact', {
        p_ride_id: rideId,
      });
      if (error) throw error;

      const row = (Array.isArray(data) ? data[0] : data) as
        | (Partial<CancellationRatingImpact> & { error?: string })
        | null;
      if (!row || row.error) return fallback;
      return {
        rating_penalized: row.rating_penalized ?? false,
        is_grace: row.is_grace ?? true,
        cancel_count_24h: row.cancel_count_24h ?? 0,
        rating_value: row.rating_value ?? null,
        stars_before: row.stars_before ?? null,
        stars_after: row.stars_after ?? null,
      };
    } catch {
      return fallback;
    }
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
   *
   * P-HIGH-6 (migration 00321): la tabla `promotions` ya no expone
   * SELECT a usuarios authenticated (RLS policy `promo_select`
   * eliminada). La RPC `validate_promo_code` SECURITY DEFINER hace
   * la validación + cálculo server-side y devuelve solo
   * `{ valid, promotion_id, code, type, discount_amount, error }`.
   * El client NO necesita ver `discount_percent`, `max_uses`,
   * `created_by`, etc.
   *
   * Tolerancia: si la migración 00321 no se aplicó aún (PGRST202 /
   * function does not exist), fallback al flujo legacy de query
   * directa a `promotions` — sigue funcionando porque la policy
   * vieja `promo_select` aún existe pre-migración.
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

    const { data: rpcData, error: rpcError } = await supabase.rpc('validate_promo_code', {
      p_code: params.code.trim(),
      p_user_id: params.userId,
      p_fare_amount: params.fareAmount,
    });

    if (!rpcError && rpcData && typeof rpcData === 'object') {
      const result = rpcData as {
        valid?: boolean;
        promotion_id?: string;
        code?: string;
        type?: Promotion['type'];
        discount_amount?: number;
        error?: string;
      };
      if (result.valid) {
        return {
          valid: true,
          // Minimal Promotion stub — callers only need id + code + type.
          promotion: {
            id: result.promotion_id!,
            code: result.code!,
            type: result.type!,
          } as Promotion,
          discountAmount: result.discount_amount ?? 0,
        };
      }
      return {
        valid: false,
        discountAmount: 0,
        error: result.error ?? 'invalid',
      };
    }

    // Tolerate missing RPC (migration 00321 not yet applied).
    const isMissingFn =
      rpcError?.code === 'PGRST202' ||
      /function .* does not exist|could not find the function/i.test(rpcError?.message ?? '');
    if (rpcError && !isMissingFn) {
      throw rpcError;
    }

    // ---- Legacy fallback (works only while pre-migration RLS allows it) ----
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

    if (promotion.valid_until && new Date(promotion.valid_until) < new Date()) {
      return { valid: false, discountAmount: 0, error: 'expired' };
    }
    if (promotion.max_uses !== null && promotion.current_uses >= promotion.max_uses) {
      return { valid: false, discountAmount: 0, error: 'max_uses' };
    }

    const { data: existing } = await supabase
      .from('promotion_uses')
      .select('id')
      .eq('promotion_id', promotion.id)
      .eq('user_id', params.userId)
      .maybeSingle();
    if (existing) {
      return { valid: false, discountAmount: 0, error: 'already_used' };
    }

    let discountAmount = 0;
    if (
      (promotion.type === 'percentage_discount' || promotion.type === 'bonus_credit') &&
      promotion.discount_percent
    ) {
      discountAmount = Math.min(
        Math.round(params.fareAmount * promotion.discount_percent / 100),
        params.fareAmount,
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
      .subscribe(realtimeStatusLogger('ride_offers'));
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
  ): Promise<{ extraDistanceKm: number; extraFareCup: number; newTotalCup?: number }> {
    const supabase = getSupabaseClient();

    // Server-authoritative preview (mig 00386): the same `_waypoint_pricing`
    // helper the trigger uses to PERSIST the new fare, so the "+$Y" shown here
    // == the increase actually charged. Falls back to the local estimate below
    // if the RPC isn't deployed yet (migration not applied to prod).
    try {
      const { data, error } = await supabase.rpc('estimate_waypoint_surcharge_preview', {
        p_ride_id: rideId,
        p_lat: latitude,
        p_lng: longitude,
      });
      if (!error && data && typeof data === 'object' && !('error' in (data as object))) {
        const d = data as { extra_distance_km?: number; extra_fare_cup?: number; new_total_cup?: number };
        return {
          extraDistanceKm: Number(d.extra_distance_km ?? 0),
          extraFareCup: Number(d.extra_fare_cup ?? 0),
          newTotalCup: d.new_total_cup != null ? Number(d.new_total_cup) : undefined,
        };
      }
    } catch {
      // RPC missing or failed → fall through to the local estimate below.
    }

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
    // Optional suffix so two subscribers on the SAME device (e.g. the driver's
    // trip sheet + its map-data hook) don't collide on the same channel topic.
    channelSuffix?: string,
  ) {
    const supabase = getSupabaseClient();
    return supabase
      .channel(`waypoints-${rideId}${channelSuffix ? `-${channelSuffix}` : ''}`)
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
      .subscribe(realtimeStatusLogger('waypoints'));
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
      .subscribe(realtimeStatusLogger('splits'));
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

    // Intermediate stops (mid-ride waypoints) → addresses in visit order, so
    // the receipt lists them between pickup and dropoff. Best-effort: a query
    // failure must never break the receipt.
    let stops: string[] | undefined;
    try {
      const { data: wps } = await supabase
        .from('ride_waypoints')
        .select('address, sort_order')
        .eq('ride_id', rideId)
        .order('sort_order', { ascending: true });
      const addrs = (wps ?? [])
        .map((w) => (w as { address?: string | null }).address)
        .filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
      if (addrs.length > 0) stops = addrs;
    } catch { /* no stops on the receipt */ }

    const base = {
      receiptNo,
      rideId: ride.id as string,
      date: dateISO,
      pickupAddress: ride.pickup_address as string,
      stops,
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

      // BUG-fare-display-parity: el PDF passenger muestra
      // "subtotal + surge + tip - discount = total cobrado". Antes
      // `totalCup` se quedaba en `final_fare_cup`, que NO incluye tip
      // (el RPC complete_ride_and_pay no la suma; add_tip solo updatea
      // tip_amount aparte). Resultado: el rider veía aritmética rota
      // ("subtotal $200 + tip $20 = total $200"). Sumar tip aquí lo
      // alinea con lo que efectivamente el wallet debitó.
      const tipCup = (ride.tip_amount as number | null) ?? 0;
      const totalChargedCup = totalCup + tipCup;
      // fareTrc se computa con la misma lógica (1 TRC = 1 CUP peg, no
      // hace falta conversión del tip).
      const baseFareTrc = (ride.final_fare_trc as number | null) ?? (ride.estimated_fare_trc as number | null);
      const fareTrc = baseFareTrc != null ? baseFareTrc + tipCup : null;

      return {
        variant: 'passenger',
        ...base,
        driverName: (driverUser?.full_name as string | null) ?? null,
        vehiclePlate,
        subtotalCup,
        surgeMultiplier: surgeMult,
        surgeAmountCup,
        discountCup: (ride.discount_amount_cup as number | null) ?? 0,
        tipCup,
        totalCup: totalChargedCup,
        fareTrc,
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
