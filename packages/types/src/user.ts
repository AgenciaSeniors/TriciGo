// ============================================================
// TriciGo — User & Customer Types
// ============================================================

import type { Language, PaymentMethod, UserLevel, UserRole } from './enums';

export interface User {
  id: string;
  phone: string;
  email: string | null;
  full_name: string;
  role: UserRole;
  avatar_url: string | null;
  preferred_language: Language;
  level: UserLevel;
  total_rides: number;
  total_spent: number;
  cancellation_count: number;
  last_cancellation_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SavedLocation {
  label: string;
  address: string;
  latitude: number;
  longitude: number;
}

export interface EmergencyContact {
  name: string;
  phone: string;
  relationship: string;
}

export interface CustomerProfile {
  id: string;
  user_id: string;
  default_payment_method: PaymentMethod;
  saved_locations: SavedLocation[];
  emergency_contact: EmergencyContact | null;
  created_at: string;
  updated_at: string;
}

export interface UserDevice {
  id: string;
  user_id: string;
  push_token: string | null;
  platform: 'ios' | 'android' | 'web';
  created_at: string;
}
