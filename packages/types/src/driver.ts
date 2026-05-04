// ============================================================
// TriciGo — Driver Types
// ============================================================

import type { DocumentType, DriverStatus, VehicleType } from './enums';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * Driver matching preferences — equivalente por rol al `RidePreferences`
 * del rider. Almacenado en `driver_profiles.preferences` JSONB.
 *
 * Diferencia con `vehicles.accepts_cargo` y similar: estos son sobre
 * CAPACIDAD del vehículo. `DriverPreferences` son PREFERENCIAS personales
 * del conductor para el matching engine.
 */
export interface DriverPreferences {
  /** Distancia máxima al pickup que el driver acepta (km). Default 30. */
  max_distance_km?: number;
  /** Acepta viajes >10km (puede ser largos a otra provincia). Default true. */
  accepts_long_trips?: boolean;
  /** Tolerancia de música del rider durante el viaje. Default 'low'. */
  music_preference?: 'none' | 'low' | 'any';
  /** Acepta riders menores de edad sin adulto acompañante. Default true. */
  accepts_minors_alone?: boolean;
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
  /** Driver matching preferences (parity with users.ride_preferences) */
  preferences?: DriverPreferences;
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
