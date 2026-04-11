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
  /** Fee charged for cancellation based on ride state (CUP/TRC whole units) */
  cancellation_fee_cup: number;
  /** Fee charged for cancellation in TRC whole units (= CUP) */
  cancellation_fee_trc: number;

  // Safety
  share_token: string | null;

  // Promo
  promo_code_id: string | null;
  discount_amount_cup: number;

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
}

export interface Tip {
  id: string;
  ride_id: string;
  from_user_id: string;
  to_driver_id: string;
  amount: number;
  created_at: string;
}

export interface SurgeZone {
  id: string;
  zone_id: string | null;
  multiplier: number;
  reason: string | null;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  created_by: string | null;
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

/** Preview of cancellation fee before confirming */
export interface CancellationFeePreview {
  fee_cup: number;
  fee_trc: number;
  fee_reason: string;
  is_free: boolean;
}

export interface RideWithRider extends Ride {
  rider_name: string;
  rider_avatar_url: string | null;
  rider_rating: number;
}

// ── Realtime Searching Types ──────────────────────────────

/** Driver presence state during ride search (Supabase Presence) */
export interface SearchingDriverPresence {
  driverId: string;
  name: string;
  avatarUrl: string | null;
  vehicleType: string;
  rating: number;
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
  rating: number;
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
 * Does NOT include: driver phone, exact addresses, fare amounts,
 * payment details, promo codes, or customer identifiers.
 */
export interface SharedRideView {
  id: string;
  status: RideStatus;
  service_type: ServiceTypeSlug;

  // Coordinates only (NOT full addresses)
  pickup_location: GeoPoint;
  dropoff_location: GeoPoint;

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
