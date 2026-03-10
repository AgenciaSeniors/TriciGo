// ============================================================
// TriciGo — Ride Types
// Full ride lifecycle: searching → completed/canceled/disputed
// ============================================================

import type {
  PaymentMethod,
  PricingSnapshotType,
  RideStatus,
  ServiceTypeSlug,
  UserRole,
} from './enums';
import type { GeoPoint } from './driver';

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
  completed_at: string | null;
  canceled_at: string | null;
  canceled_by: string | null;
  cancellation_reason: string | null;

  // Safety
  share_token: string | null;

  // Promo
  promo_code_id: string | null;
  discount_amount_cup: number;

  // Surge & Tips
  surge_multiplier: number;
  tip_amount: number;

  created_at: string;
  updated_at: string;
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
  commission_amount: number;
  driver_earnings: number;
  payment_method: string;
  share_token: string;
}

/** Ride with joined driver info for client display */
export interface RideWithDriver extends Ride {
  driver_user_id: string | null;
  driver_name: string | null;
  driver_avatar_url: string | null;
  driver_rating: number | null;
  driver_phone: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  vehicle_plate: string | null;
}
