// ============================================================
// TriciGo — Recurring Ride Types
// ============================================================

import type { PaymentMethod, ServiceTypeSlug } from './enums';

export type RecurringRideStatus = 'active' | 'paused' | 'deleted';

export interface RecurringRide {
  id: string;
  user_id: string;

  // Route
  pickup_latitude: number;
  pickup_longitude: number;
  pickup_address: string;
  dropoff_latitude: number;
  dropoff_longitude: number;
  dropoff_address: string;

  // Ride config
  service_type: ServiceTypeSlug;
  payment_method: PaymentMethod;

  // Schedule: ISO days (1=Mon..7=Sun), time in HH:MM local
  days_of_week: number[];
  time_of_day: string;
  timezone: string;

  // State
  status: RecurringRideStatus;
  next_occurrence_at: string | null;
  last_ride_created_at: string | null;

  created_at: string;
  updated_at: string;
}
