// ============================================================
// TriciGo — Vehicle Types
// ============================================================

import type { VehicleType } from './enums';

export interface Vehicle {
  id: string;
  driver_id: string;
  type: VehicleType;
  make: string;
  model: string;
  year: number;
  color: string;
  plate_number: string;
  capacity: number;
  accepts_cargo: boolean;
  max_cargo_weight_kg: number | null;
  is_active: boolean;
  photo_url: string | null;
  created_at: string;
  updated_at: string;
}
