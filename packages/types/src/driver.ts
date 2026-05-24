// ============================================================
// TriciGo — Driver Types
// ============================================================

import type { DocumentType, DriverStatus, VehicleType } from './enums';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface DriverProfile {
  id: string;
  user_id: string;
  status: DriverStatus;
  is_online: boolean;
  is_on_break: boolean;
  current_location: GeoPoint | null;
  current_heading: number | null;
  rating_avg: number;
  total_rides: number;
  total_rides_completed: number;
  zone_id: string | null;
  approved_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  match_score: number;
  acceptance_rate: number;
  total_rides_offered: number;
  is_financially_eligible: boolean;
  negative_balance_since: string | null;
  /** Driver's custom per-km rate in CUP whole pesos. null = use default */
  custom_per_km_rate_cup: number | null;
  /** Whether the driver has auto-accept enabled for incoming rides */
  auto_accept_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type ScoreEventType =
  | 'ride_completed'
  | '5_star_rating'
  | '4_star_rating'
  | '3_star_rating'
  | '2_star_rating'
  | '1_star_rating'
  | 'cancel_by_driver'
  | 'sos_report'
  | 'tip_received'
  | 'ride_declined'
  | 'consecutive_completions_5'
  | 'admin_adjustment';

export interface DriverScoreEvent {
  id: string;
  driver_id: string;
  event_type: ScoreEventType;
  delta: number;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface DriverMatchResult {
  driver_id: string;
  user_id: string;
  distance_m: number;
  match_score: number;
  rating_avg: number;
  acceptance_rate: number;
  composite_score: number;
}

export interface CancellationPenalty {
  id: string;
  user_id: string;
  ride_id: string | null;
  amount: number;
  reason: string | null;
  created_at: string;
}

export interface DriverDocument {
  id: string;
  driver_id: string;
  document_type: DocumentType;
  storage_path: string;
  file_name: string;
  uploaded_at: string;
  is_verified: boolean;
  verified_by: string | null;
  verified_at: string | null;
  rejection_reason: string | null;
  verification_notes: string | null;
  face_match_score: number | null;
  liveness_passed: boolean | null;
  mime_type?: string;
}

export type SelfieCheckStatus = 'pending' | 'processing' | 'passed' | 'failed' | 'expired';

export interface SelfieCheck {
  id: string;
  driver_id: string;
  storage_path: string;
  face_match_score: number | null;
  liveness_passed: boolean | null;
  status: SelfieCheckStatus;
  requested_at: string;
  completed_at: string | null;
  expires_at: string;
}

export interface DriverStatusHistoryEntry {
  id: string;
  driver_id: string;
  from_status: DriverStatus | null;
  to_status: DriverStatus;
  changed_by: string;
  reason: string | null;
  created_at: string;
}

/**
 * Active (open) work session for a driver, returned by the RPC
 * `get_active_work_session` (migration 00261). Returned shape is
 * a single object or null (the home bottom-sheet hook normalizes
 * the 0/1-row response). Used to derive `sessionHours` for the
 * anti-fatigue banner with cross-device persistence.
 */
export interface DriverActiveWorkSession {
  id: string;
  started_at: string;
  /** Live derived count from the RPC — re-fetch the RPC if you need a fresher value. */
  minutes_online: number;
}

/**
 * Per-day adherence row from `get_driver_work_adherence` (migration
 * 00261). Compares actual online minutes vs planned minutes derived
 * from active `driver_recurring_shifts` (D5). One row per day in the
 * requested window; sessions spanning midnight are split.
 */
export interface DriverWorkAdherenceDay {
  day: string;
  actual_minutes_online: number;
  planned_minutes: number;
}

/**
 * Per-driver per-day performance rollup, returned by the RPC
 * `get_driver_performance_trend` (migration 00260). Powers the 30-day
 * sparklines on `/profile/performance` (Phase 2 N3 deep slice).
 *
 * `avg_response_time_s` is null when no rides were accepted that day.
 */
export interface DriverPerformanceTrendDay {
  day: string;
  completed_count: number;
  canceled_count: number;
  accepted_count: number;
  avg_response_time_s: number | null;
}

/**
 * Per-driver earnings × hour-of-week cell, returned by the RPC
 * `get_driver_peak_hours_personal` (migration 00258). Used to render
 * the "Tus mejores horas" 7 × 24 heatmap on the earnings tab.
 */
export interface DriverPeakHourCell {
  /** 0 = Sunday, 6 = Saturday (matches Postgres EXTRACT(DOW)). */
  day_of_week: number;
  /** 0..23 server-local. */
  hour_of_day: number;
  total_earnings_cup: number;
  trip_count: number;
}

/** Nearby vehicle for map display (returned by find_nearby_vehicles RPC) */
export interface NearbyVehicle {
  driver_profile_id: string;
  latitude: number;
  longitude: number;
  heading: number | null;
  vehicle_type: VehicleType;
  custom_per_km_rate_cup: number | null;
  /** ETA from vehicle position to pickup point (seconds) */
  eta_seconds?: number | null;
  /** Distance from vehicle to pickup point (meters) */
  distance_to_pickup_m?: number | null;
}
