// ============================================================
// TriciGo — User & Customer Types
// ============================================================

import type { Language, PaymentMethod, UserLevel, UserRole } from './enums';
import type { RidePreferences } from './ride';

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
  sms_notifications_enabled: boolean;
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
  /** Average rating from drivers (1-5), default 5.00 */
  rating_avg: number;
  /** Rider default trip preferences */
  ride_preferences?: RidePreferences;
  created_at: string;
  updated_at: string;
}

export interface TrustedContact {
  id: string;
  user_id: string;
  name: string;
  phone: string;
  relationship: string;
  auto_share: boolean;
  is_emergency: boolean;
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
