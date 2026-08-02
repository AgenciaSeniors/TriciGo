// ============================================================
// TriciGo — Ride Types
// Full ride lifecycle: searching → completed/canceled/disputed
// ============================================================

import type {
  PaymentMethod,
  PaymentStatus,
  PricingSnapshotType,
  RideMode,
  RideStatus,
  ServiceTypeSlug,
  UserRole,
} from './enums';
import type { GeoPoint } from './driver';

export type AccessibilityNeed =
  | 'wheelchair'
  | 'hearing_impaired'
  | 'visual_impaired'
  | 'service_animal'
  | 'extra_space';

export interface RidePreferences {
  quiet_mode?: boolean;
  temperature?: 'cool' | 'warm' | 'no_preference';
  conversation_ok?: boolean;
  luggage_trunk?: boolean;
  /** Accessibility needs for this ride */
  accessibility_needs?: AccessibilityNeed[];
}

export interface Waypoint {
  id: string;
  ride_id: string;
  sort_order: number;
  location: GeoPoint;
  address: string;
  arrived_at?: string;
  departed_at?: string;
  created_at: string;
}

export type SplitPaymentStatus = 'pending' | 'paid' | 'failed';

export interface RideSplit {
  id: string;
  ride_id: string;
  user_id: string;
  /** Joined from users table */
  user_name?: string;
  user_avatar_url?: string;
  user_phone?: string;
  share_pct: number;
  amount_trc: number | null;
  payment_status: SplitPaymentStatus;
  invited_by: string;
  accepted_at: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface Ride {
  id: string;
  customer_id: string;
  driver_id: string | null;
  service_type: ServiceTypeSlug;
  status: RideStatus;
  payment_method: PaymentMethod;

  // Locations
  pickup_location: GeoPoint;
  pickup_address: string;
  dropoff_location: GeoPoint;
  dropoff_address: string;

  // Estimates (set at request time)
  estimated_fare_cup: number;
  estimated_distance_m: number;
  estimated_duration_s: number;

  // Actuals (set at completion)
  final_fare_cup: number | null;
  actual_distance_m: number | null;
  actual_duration_s: number | null;

  // Scheduling
  scheduled_at: string | null;
  is_scheduled: boolean;

  // Timestamps
  accepted_at: string | null;
  driver_arrived_at: string | null;
  pickup_at: string | null;
  arrived_at_destination_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  canceled_by: string | null;
  cancellation_reason: string | null;
  /** Structured cancellation reason code (migration 00486); null for legacy rides. */
  cancellation_reason_code: CancellationReasonCode | null;
  /** Fee charged for cancellation based on ride state (CUP/TRC whole units) */
  cancellation_fee_cup: number;
  /** Fee charged for cancellation in TRC whole units (= CUP) */
  cancellation_fee_trc: number;

  // Safety
  share_token: string | null;

  // Promo
  promo_code_id: string | null;
  discount_amount_cup: number;

  // Compartir viaje (shared ride) — 00347
  shared_ride?: boolean;
  shared_ride_seats_occupied?: number | null;
  shared_ride_discount_cup?: number;

  // Surge & Tips
  surge_multiplier: number;
  tip_amount: number;

  // Exchange rate snapshot (1 USD = X CUP/TRC at ride creation, from eltoque)
  exchange_rate_usd_cup: number | null;
  // Fare in TRC whole units (= CUP since 1:1 peg)
  estimated_fare_trc: number | null;
  final_fare_trc: number | null;
  // Fare in USD (derived from exchange rate)
  estimated_fare_usd: number | null;
  final_fare_usd: number | null;
  // Driver custom rate at time of assignment (CUP/TRC whole units)
  driver_custom_rate_cup: number | null;
  // Quota deduction for this ride (TRC whole units, driver-side)
  quota_deduction_amount: number | null;

  // Payment tracking
  payment_status: PaymentStatus;
  payment_intent_id: string | null;

  created_at: string;
  updated_at: string;

  // Corporate
  corporate_account_id: string | null;

  waypoints?: Waypoint[];
  next_ride_id?: string;
  is_chained?: boolean;

  // Fare splitting
  is_split?: boolean;
  splits?: RideSplit[];

  // Trip insurance
  insurance_selected?: boolean;
  insurance_premium_cup?: number;

  // Ride preferences
  rider_preferences?: RidePreferences | null;

  // Passenger count
  passenger_count: number;

  // Wait time penalty
  wait_time_minutes: number;
  wait_time_charge_cup: number;

  // Ride mode
  ride_mode: RideMode;

  // Mixed payment
  wallet_ratio: number | null;
  wallet_amount_cup: number | null;
  cash_amount_cup: number | null;

  // Ride-offer window (only set when fetched via getSearchingRides
  // for the authenticated driver). Present as timestamp ISO string.
  offer_expires_at?: string;

  // BUG-246: GPS unavailable flow — set by the driver-side reportGpsUnavailable
  // RPC when the driver's GPS is broken mid-ride. The rider sees a consent modal.
  driver_gps_status?: 'unavailable' | 'rider_consented' | 'resolved' | null;

  // GPS override / confirm-arrival flow — set when the driver reports arrival
  // but their GPS puts them too far from the pickup. The rider gets a modal
  // ("¿Tu conductor está acá?") and confirms via rider_confirm_driver_arrival.
  gps_override_requested_at?: string | null;
  gps_override_confirmed_at?: string | null;
  /** Distance (m) between the driver's reported GPS and the pickup point. */
  gps_check_distance_m?: number | null;

  // BUG-222: excess distance fields — set by complete_ride_and_pay when the
  // driver traveled more than 1.3× the estimated distance.
  excess_distance_uncharged_m?: number | null;
  excess_distance_reason?: string | null;
}

/**
 * Aggregate stats of the offers a ride has generated, scoped to the
 * ride's customer via `get_ride_offer_stats` RPC (migration 00127).
 * Used by the rider SearchingView to surface progress.
 */
export interface RideOfferStats {
  pending_count: number;
  accepted_count: number;
  expired_count: number;
  /** ISO timestamp — when the next pending offer expires (null if none). */
  earliest_expires_at: string | null;
  /** ISO timestamp — when the last dispatch round started (null if pre-00126). */
  last_dispatched_at: string | null;
  /** 0 = not yet dispatched, 1..3 = active round. */
  dispatch_round: number;
}

/**
 * Demand hotspot for the driver map. Produced by the
 * `get_demand_hotspots` RPC (migration 00125).
 */
export interface DemandHotspot {
  id: string;
  lat: number;
  lng: number;
  /** 0..1 — combined historical + live score. Drives pulse color. */
  intensity: number;
  live_rides_count: number;
  historical_rides_count: number;
}

/**
 * Popular pickup/dropoff cluster from the `popular_locations`
 * materialized view (migration 00083). 90-day historical aggregate
 * of completed rides clustered by ST_ClusterDBSCAN. Refreshed daily.
 *
 * Different from `DemandHotspot`: that one folds a live boost into a
 * matching hour-of-week pattern; this one is the pure historical
 * "where trips usually start/end" view used for stable map markers
 * the driver can keep on screen.
 */
export interface PopularLocation {
  id: number;
  latitude: number;
  longitude: number;
  address: string;
  /** 'pickup' | 'dropoff' — clusters are split by direction. */
  type: 'pickup' | 'dropoff';
  ride_count: number;
  /** Distance from the query point in metres. */
  distance_m: number;
}

export interface Tip {
  id: string;
  ride_id: string;
  from_user_id: string;
  to_driver_id: string;
  amount: number;
  created_at: string;
}

export interface RideTransition {
  id: string;
  ride_id: string;
  from_status: RideStatus | null;
  to_status: RideStatus;
  actor_id: string;
  actor_role: UserRole;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface RideLocationEvent {
  id: string;
  ride_id: string;
  driver_id: string;
  latitude: number;
  longitude: number;
  heading: number | null;
  speed: number | null;
  accuracy: number | null;
  recorded_at: string;
}

export interface RidePricingSnapshot {
  id: string;
  ride_id: string;
  snapshot_type: PricingSnapshotType;
  base_fare: number;
  per_km_rate: number;
  per_minute_rate: number;
  distance_m: number;
  duration_s: number;
  surge_multiplier: number;
  subtotal: number;
  commission_rate: number;
  commission_amount: number;
  total: number;
  pricing_rule_id: string | null;
  exchange_rate_usd_cup: number | null;
  total_trc: number | null;
  created_at: string;
}

/** Valid FSM transition definition */
export interface RideValidTransition {
  from_status: RideStatus;
  to_status: RideStatus;
  allowed_roles: UserRole[];
}

/** Result from complete_ride_and_pay RPC */
export interface CompleteRideResult {
  final_fare_cup: number;
  final_fare_trc: number;
  final_fare_usd: number;
  exchange_rate_usd_cup: number;
  /** @deprecated Use quota_deduction_amount instead */
  commission_amount: number;
  driver_earnings: number;
  payment_method: string;
  share_token: string;
  surge_multiplier: number;
  driver_custom_rate_cup: number | null;
  payment_status: PaymentStatus;
  insurance_selected?: boolean;
  insurance_premium_cup?: number;
  insurance_premium_trc?: number;
  /** Amount deducted from driver's quota for this ride */
  quota_deduction_amount: number;
  /** Driver's remaining quota balance after deduction */
  quota_balance_after: number;
  /** BUG-222: meters driven beyond 1.3× the estimated distance, uncharged */
  excess_distance_uncharged_m?: number | null;
  /** Mixed payment split the RPC computes and returns (00340): the wallet
   *  (TriciCoin) and cash portions of the final fare, in CUP. 0 for
   *  non-mixed rides. Used by the driver completed screen to show how much
   *  to collect in cash vs. what came from the rider's wallet. */
  wallet_amount_cup?: number | null;
  cash_amount_cup?: number | null;
  /** 00537: distance the server settled on (trail-derived when available,
   *  else the client-reported value). Show THIS on the trip summary. */
  actual_distance_m?: number | null;
  /** 00537: distance computed server-side from the ride GPS trail
   *  (compute_ride_trail_distance_m). NULL when no usable trail. */
  server_distance_m?: number | null;
  /** 00537: distance exactly as the app reported it (audit). */
  reported_distance_m?: number | null;
}

/** Ride with joined rider info for driver display */
/** Cancellation fee configuration per service type */
export interface CancellationFeeConfig {
  id: string;
  service_type: ServiceTypeSlug;
  free_cancel_window_s: number;
  en_route_fee_cup: number;
  arrived_fee_cup: number;
  in_progress_fee_pct: number;
  in_progress_min_fee_cup: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Impact of a cancellation on the canceller's VISIBLE star rating.
 * Replaces the old money-based CancellationFeePreview: cancelling no
 * longer charges CUP — a late cancellation lowers `rating_avg` instead
 * (migrations 00370/00371). Symmetric for riders and drivers.
 */
export interface CancellationRatingImpact {
  /** Whether cancelling now actually lowers the rating. */
  rating_penalized: boolean;
  /** True when this cancellation has no rating impact (no driver yet, within the grace window, or 1st of the day). */
  is_grace: boolean;
  /** This user's late cancellations in the last 24h (before this one). */
  cancel_count_24h: number;
  /** Pseudo-rating this cancellation contributes (e.g. 3.0 stars), or null in grace. */
  rating_value: number | null;
  /** Visible stars before the cancellation. */
  stars_before: number | null;
  /** Visible (or estimated, for previews) stars after the cancellation. */
  stars_after: number | null;
}

/**
 * Structured cancellation reason codes (migration 00486). Replace the old
 * free-text reason so the reputation penalty can be exempted per-reason and
 * the Phase-2 collusion detection has a queryable signal.
 */
export type CancellationReasonCode =
  // No exentos — entran a la progresión reputacional fuera de la ventana de gracia.
  | 'changed_plans'
  | 'driver_delay'
  | 'wrong_price'
  | 'other'
  // Exentos — no penalizan la reputación.
  | 'no_show'
  | 'passenger_gone'
  | 'breakdown'
  | 'safety'
  | 'emergency';

/** Reason codes exempt from the reputation penalty (must match migration 00486). */
export const EXEMPT_CANCELLATION_REASONS: readonly CancellationReasonCode[] = [
  'no_show', 'passenger_gone', 'breakdown', 'safety', 'emergency',
];

/** Reasons a PASSENGER can pick when cancelling. */
export const PASSENGER_CANCELLATION_REASONS: readonly CancellationReasonCode[] = [
  'changed_plans', 'driver_delay', 'wrong_price', 'safety', 'other',
];

/** Reasons a DRIVER can pick when cancelling. `no_show` is sent by the "passenger no-show" button. */
export const DRIVER_CANCELLATION_REASONS: readonly CancellationReasonCode[] = [
  'no_show', 'breakdown', 'safety', 'emergency', 'changed_plans', 'other',
];

/** True when a reason code is exempt from the reputation penalty. */
export function isExemptCancellationReason(code?: string | null): boolean {
  return !!code && (EXEMPT_CANCELLATION_REASONS as readonly string[]).includes(code);
}

export interface RideWithRider extends Ride {
  rider_name: string;
  rider_avatar_url: string | null;
  rider_rating: number | null;
  /** Full E.164 phone for the in-ride "Llamar al pasajero" button. Null unless
   *  the ride is active and the membership-gated RPC surfaced it. */
  rider_phone: string | null;
  rider_masked_phone: string | null;
}

// ── Realtime Searching Types ──────────────────────────────

/** Driver presence state during ride search (Supabase Presence) */
export interface SearchingDriverPresence {
  driverId: string;
  name: string;
  avatarUrl: string | null;
  vehicleType: string;
  // Nullable: a brand-new driver/rider with no reviews has rating_avg = null.
  rating: number | null;
  location: GeoPoint; // jittered ~200m for privacy
  joinedAt: number; // Date.now() timestamp
}

/** Broadcast payload when a driver accepts (fast path before DB RPC) */
export interface DriverAcceptedBroadcast {
  type: 'driver_accepted';
  driverId: string;
  name: string;
  avatarUrl: string | null;
  vehicleType: string;
  // Nullable: a brand-new driver with no reviews has rating_avg = null.
  rating: number | null;
  location: GeoPoint; // real location (no jitter)
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleColor: string | null;
  vehiclePlate: string | null;
}

/** Ride with joined driver info for client display */
export interface RideWithDriver extends Ride {
  driver_user_id: string | null;
  driver_name: string | null;
  driver_avatar_url: string | null;
  driver_rating: number | null;
  driver_phone: string | null;
  driver_masked_phone: string | null;
  /** Total completed rides by this driver */
  driver_total_rides: number | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  vehicle_plate: string | null;
  /** Vehicle photo from Supabase Storage */
  vehicle_photo_url: string | null;
  /** Vehicle manufacturing year */
  vehicle_year: number | null;
  /** Vehicle type slug (triciclo, moto, auto, confort) */
  vehicle_type: string | null;
}

/**
 * Privacy-safe subset of ride data exposed via public share token.
 * Does NOT include: driver phone, fare amounts, payment details,
 * promo codes, or customer identifiers.
 *
 * Pickup/dropoff addresses ARE included: the share token is the
 * authorization (the rider hands it out) and expires 24h after the
 * ride completes — showing trusted contacts the real addresses is the
 * expected behaviour of a "share my trip" feature (same as Uber).
 */
export interface SharedRideView {
  id: string;
  status: RideStatus;
  service_type: ServiceTypeSlug;

  // Coordinates + human-readable addresses
  pickup_location: GeoPoint;
  dropoff_location: GeoPoint;
  pickup_address: string | null;
  dropoff_address: string | null;

  // Timing
  estimated_duration_s: number;
  accepted_at: string | null;
  pickup_at: string | null;
  arrived_at_destination_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;

  // Driver (safe fields only)
  driver_first_name: string | null;
  driver_avatar_url: string | null;
  driver_rating: number | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  vehicle_plate: string | null;
  vehicle_photo_url: string | null;
  vehicle_type: string | null;

  // Waypoints (intermediate stops, in visit order). Address is kept
  // out on purpose — coords are enough to draw the route + markers.
  waypoints: Array<{
    id: string;
    sort_order: number;
    latitude: number;
    longitude: number;
    arrived_at: string | null;
    departed_at: string | null;
  }>;
}

/**
 * Live/dynamic slice of a shared ride — what the public tracking page
 * polls every few seconds (get_shared_trip_state RPC). Status + the
 * latest driver GPS sample. No driver_id exposed.
 */
export interface SharedTripState {
  status: RideStatus;
  accepted_at: string | null;
  pickup_at: string | null;
  arrived_at_destination_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  /** Latest driver GPS fix — null until the driver uploads one. */
  driver_location: GeoPoint | null;
  /** Heading in degrees (0=N, 90=E). null when unknown. */
  driver_heading: number | null;
  /** Server timestamp of the latest GPS fix (ISO). */
  driver_recorded_at: string | null;
}

/** Trip progress state for Uber-style progress bar */
export interface TripProgress {
  /** Percentage of trip completed (0-100) */
  progressPercent: number;
  /** Distance remaining in meters */
  distanceRemainingM: number;
  /** Total trip distance in meters */
  totalDistanceM: number;
  /** ETA in minutes */
  etaMinutes: number | null;
  /** Formatted arrival time (e.g., "3:45pm") */
  arrivalTime: string | null;
}
