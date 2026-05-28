// ============================================================
// TriciGo — Admin & Audit Types
// ============================================================

import type { DriverProfile } from './driver';
import type { VehicleType, RideStatus, DriverStatus } from './enums';

export interface DriverProfileWithUser extends DriverProfile {
  users: {
    full_name: string;
    phone: string;
    email: string | null;
  };
  vehicles?: { type: VehicleType; plate_number: string }[];
}

// 00339 — Returned by admin_get_online_fleet() RPC for the
// /admin/fleet map. Each row is one driver online right now with
// approved status and a current_location, plus their active ride
// (if any) so the map can color-code by state.
export interface OnlineFleetDriver {
  driver_id: string;
  user_id: string;
  full_name: string;
  phone: string;
  status: DriverStatus;
  is_online: boolean;
  is_on_break: boolean;
  last_heartbeat_at: string | null;
  lat: number;
  lng: number;
  current_heading: number | null;
  current_ride_id: string | null;
  current_ride_status: RideStatus | null;
}

export interface AdminAction {
  id: string;
  admin_id: string;
  action: string;
  target_type: string;
  target_id: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

export interface AuditLog {
  id: string;
  table_name: string;
  record_id: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  changed_by: string | null;
  created_at: string;
}
