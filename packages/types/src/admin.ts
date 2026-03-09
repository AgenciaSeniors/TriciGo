// ============================================================
// TriciGo — Admin & Audit Types
// ============================================================

import type { DriverProfile } from './driver';
import type { VehicleType } from './enums';

export interface DriverProfileWithUser extends DriverProfile {
  users: {
    full_name: string;
    phone: string;
    email: string | null;
  };
  vehicles?: { type: VehicleType; plate_number: string }[];
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
