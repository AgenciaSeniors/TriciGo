// ============================================================
// TriciGo — Driver Types
// ============================================================

import type { DocumentType, DriverStatus } from './enums';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface DriverProfile {
  id: string;
  user_id: string;
  status: DriverStatus;
  is_online: boolean;
  current_location: GeoPoint | null;
  current_heading: number | null;
  rating_avg: number;
  total_rides: number;
  total_rides_completed: number;
  zone_id: string | null;
  approved_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  is_financially_eligible: boolean;
  negative_balance_since: string | null;
  created_at: string;
  updated_at: string;
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
