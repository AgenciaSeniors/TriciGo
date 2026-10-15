// ============================================================
// TriciGo — what the admin panel reads through the panel views (00642, 00663)
// The views leave out GPS, the tracking link, wallets, documents and identity data, and
// answer admins and marketing only. Lists read them for every role; marketing's detail pages
// read only them and the tables 00663 opened to marketing.
// ============================================================

import type {
  DriverScoreEvent,
  DriverStatus,
  IncidentReport,
  PaymentMethod,
  RideDispute,
  RidePricingSnapshot,
  RideStatus,
  RideTransition,
  ServiceTypeSlug,
  User,
  VehicleType,
} from '@tricigo/types';
import { havanaDayRangeUtc } from '@tricigo/utils';
import { getSupabaseClient } from '../client';
import { escapeLikePattern, rideCodePrefix } from './_search';

export type CanceledByRole = 'customer' | 'driver' | 'staff' | 'system';

/** One row of panel_rides. */
export interface PanelRide {
  id: string;
  created_at: string;
  status: RideStatus;
  customer_id: string;
  driver_id: string | null;
  service_type: ServiceTypeSlug;
  city_id: string | null;
  estimated_fare_cup: number;
  final_fare_cup: number | null;
  final_fare_trc: number | null;
  payment_method: PaymentMethod;
  pickup_address: string;
  dropoff_address: string;
  promo_code_id: string | null;
  discount_amount_cup: number;
  shared_ride_discount_cup: number;
  dispatch_round: number;
  ride_mode: 'passenger' | 'cargo';
  is_scheduled: boolean;
  scheduled_at: string | null;
  accepted_at: string | null;
  driver_arrived_at: string | null;
  pickup_at: string | null;
  arrived_at_destination_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  canceled_by: string | null;
  canceled_by_role: CanceledByRole | null;
  cancellation_reason: string | null;
  cancellation_reason_code: string | null;
  estimated_distance_m: number | null;
  actual_distance_m: number | null;
  estimated_duration_s: number | null;
  actual_duration_s: number | null;
  wait_time_seconds: number | null;
  wait_charge_cup: number | null;
  passenger_count: number | null;
  shared_ride: boolean;
  is_split: boolean;
  corporate_account_id: string | null;
  partner_place_id: string | null;
  partner_discount_cup: number;
  tip_amount: number | null;
  surge_multiplier: number | null;
  driver_gps_status: string | null;
  searching_seen_at: string | null;
  last_dispatched_at: string | null;
  payment_status: string | null;
}

/** One row of panel_driver_profiles. */
export interface PanelDriverRow {
  id: string;
  user_id: string;
  is_online: boolean;
  total_rides_completed: number;
  total_rides: number;
  status: DriverStatus;
  rating_avg: number | null;
  acceptance_rate: number | null;
  total_rides_offered: number | null;
  city_id: string | null;
  zone_id: string | null;
  municipality: string | null;
  province: string | null;
  created_at: string;
  approved_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  is_on_break: boolean;
  auto_accept_enabled: boolean | null;
  last_heartbeat_at: string | null;
  auto_offline_at: string | null;
  terms_accepted_at: string | null;
  full_name: string;
  phone: string | null;
  email: string | null;
  vehicle_type: VehicleType | null;
  plate_number: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  vehicle_year: number | null;
}

/** A drivers-list row, shaped like the admin list it replaces. */
export interface PanelDriverListItem extends PanelDriverRow {
  users: { full_name: string; phone: string; email: string | null };
  vehicles: { type: VehicleType; plate_number: string }[];
}

export interface PanelRideFilters {
  status?: string;
  serviceType?: string;
  paymentMethod?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  cityId?: string;
  rideMode?: 'passenger' | 'cargo';
}

export interface PanelDriverFilters {
  status?: string;
  search?: string;
  ratingMin?: number;
  vehicleType?: string;
  cityId?: string;
}

function toListItem(row: PanelDriverRow): PanelDriverListItem {
  return {
    ...row,
    users: { full_name: row.full_name, phone: row.phone ?? '', email: row.email },
    vehicles: row.vehicle_type && row.plate_number
      ? [{ type: row.vehicle_type, plate_number: row.plate_number }]
      : [],
  };
}

export const panelReadService = {
  /** The rides list: panel_rides, with the admin list's filters. */
  async getRides(filters: PanelRideFilters = {}, page = 0, pageSize = 20): Promise<PanelRide[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    let query = supabase
      .from('panel_rides')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (filters.status) query = query.eq('status', filters.status);
    if (filters.serviceType) query = query.eq('service_type', filters.serviceType);
    if (filters.rideMode) query = query.eq('ride_mode', filters.rideMode);
    if (filters.paymentMethod) query = query.eq('payment_method', filters.paymentMethod);
    // Date inputs are Havana calendar days ('YYYY-MM-DD').
    if (filters.dateFrom) query = query.gte('created_at', havanaDayRangeUtc(filters.dateFrom).start.toISOString());
    if (filters.dateTo) query = query.lt('created_at', havanaDayRangeUtc(filters.dateTo).end.toISOString());
    if (filters.search) {
      const code = rideCodePrefix(filters.search);
      if (code) {
        // uuid order is byte order, so every id with this prefix lies in this range.
        query = query
          .gte('id', `${code}-0000-0000-0000-000000000000`)
          .lte('id', `${code}-ffff-ffff-ffff-ffffffffffff`);
      } else {
        const escaped = escapeLikePattern(filters.search);
        query = query.or(`pickup_address.ilike.%${escaped}%,dropoff_address.ilike.%${escaped}%`);
      }
    }
    if (filters.cityId) query = query.eq('city_id', filters.cityId);

    const { data, error } = await query;
    if (error) throw error;
    return data as PanelRide[];
  },

  /** The drivers list: panel_driver_profiles, with the admin list's filters. */
  async getDrivers(page = 0, pageSize = 20, filters: PanelDriverFilters = {}): Promise<PanelDriverListItem[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    let query = supabase
      .from('panel_driver_profiles')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
    if (filters.search) query = query.ilike('full_name', `%${escapeLikePattern(filters.search)}%`);
    if (filters.ratingMin !== undefined && filters.ratingMin > 0) query = query.gte('rating_avg', filters.ratingMin);
    if (filters.cityId) query = query.eq('city_id', filters.cityId);
    if (filters.vehicleType) query = query.eq('vehicle_type', filters.vehicleType);

    const { data, error } = await query;
    if (error) throw error;
    return (data as PanelDriverRow[]).map(toListItem);
  },
};
