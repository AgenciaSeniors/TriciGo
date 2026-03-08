// ============================================================
// TriciGo — User & Customer Types
// ============================================================

import type { Language, PaymentMethod, UserRole } from './enums';

export interface User {
  id: string;
  phone: string;
  email: string | null;
  full_name: string;
  role: UserRole;
  avatar_url: string | null;
  preferred_language: Language;
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
  device_token: string | null;
  platform: 'ios' | 'android' | 'web';
  app_version: string | null;
  last_active_at: string;
  created_at: string;
}
