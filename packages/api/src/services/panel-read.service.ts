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

export interface PanelRideDetail {
  ride: PanelRide;
  transitions: RideTransition[];
  pricing: RidePricingSnapshot | null;
  customerInfo: { name: string; phone: string | null } | null;
  driverInfo: { id: string; name: string; phone: string | null } | null;
}

export interface PanelDriverDocument {
  id: string;
  driver_id: string;
  document_type: string;
  uploaded_at: string | null;
  is_verified: boolean;
  verified_at: string | null;
  rejection_reason: string | null;
}

export interface PanelChurnRisk {
  driver_profile_id: string;
  days_since_last_ride: number | null;
  churn_risk_score: number | null;
  risk_level: string | null;
}

export interface PanelDriverDetail {
  profile: PanelDriverRow;
  documents: PanelDriverDocument[];
  scoreEvents: DriverScoreEvent[];
  churn: PanelChurnRisk | null;
}

export interface PanelUserDetail {
  user: User;
  ridesAsCustomer: number;
  completedAsCustomer: number;
  canceledAsCustomer: number;
  totalSpentCup: number;
}

/** A type with some fields that a panel view leaves out. */
type WithHidden<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type PanelDispute = WithHidden<RideDispute,
  'evidence_urls' | 'respondent_evidence_urls' | 'refund_amount_trc' | 'refund_transaction_id'
  | 'admin_notes' | 'ride_estimated_fare_trc' | 'ride_final_fare_trc'>;
export type PanelIncident = WithHidden<IncidentReport, 'evidence_urls' | 'resolution_notes'>;

export interface PanelIncidentDetail {
  incident: PanelIncident;
  reporter: { name: string; phone: string } | null;
  against: { name: string; phone: string } | null;
  resolver: { name: string; phone: string } | null;
  ride: { id: string; status: string; pickup_address: string; dropoff_address: string } | null;
  review: { id: string; rating: number; comment: string | null; is_visible: boolean; created_at: string } | null;
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

export interface ProductFailures {
  days: number;
  placesNotFound: { name: string; searches: number; lastSeen: string; imported: number }[];
  pushOutcomes: { app: string; outcome: string; users: number }[];
  pushReach: { ridersActive: number; ridersReachable: number; driversActive: number; driversReachable: number };
  appVersions: { app: string; version: string | null; platform: string | null; installs: number }[];
  failedPayments: { reason: string; payments: number; lastSeen: string }[];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];

/** What get_product_failures() returns, typed; malformed entries are dropped. */
export function parseProductFailures(raw: unknown): ProductFailures {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const reach = (typeof r.push_reach === 'object' && r.push_reach !== null ? r.push_reach : {}) as Record<string, unknown>;
  return {
    days: num(r.days),
    placesNotFound: list(r.places_not_found)
      .filter((p) => typeof p.name === 'string')
      .map((p) => ({ name: p.name as string, searches: num(p.searches), lastSeen: str(p.last_seen) ?? '', imported: num(p.imported) })),
    pushOutcomes: list(r.push_outcomes)
      .filter((p) => typeof p.app === 'string' && typeof p.outcome === 'string')
      .map((p) => ({ app: p.app as string, outcome: p.outcome as string, users: num(p.users) })),
    pushReach: {
      ridersActive: num(reach.riders_active),
      ridersReachable: num(reach.riders_reachable),
      driversActive: num(reach.drivers_active),
      driversReachable: num(reach.drivers_reachable),
    },
    appVersions: list(r.app_versions)
      .filter((p) => typeof p.app === 'string')
      .map((p) => ({ app: p.app as string, version: str(p.version), platform: str(p.platform), installs: num(p.installs) })),
    failedPayments: list(r.failed_payments)
      .filter((p) => typeof p.reason === 'string')
      .map((p) => ({ reason: p.reason as string, payments: num(p.payments), lastSeen: str(p.last_seen) ?? '' })),
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

  /** A ride for marketing: no chat, no delivery code or photos, no coordinates. */
  async getRideDetail(rideId: string): Promise<PanelRideDetail> {
    const supabase = getSupabaseClient();
    const [rideRes, transitionsRes, pricingRes] = await Promise.all([
      supabase.from('panel_rides').select('*').eq('id', rideId).single(),
      supabase.from('ride_transitions').select('*').eq('ride_id', rideId).order('created_at', { ascending: true }),
      supabase.from('ride_pricing_snapshots').select('*').eq('ride_id', rideId)
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (rideRes.error) throw rideRes.error;
    const ride = rideRes.data as PanelRide;

    const [custRes, driverRes] = await Promise.all([
      supabase.from('users').select('full_name, phone').eq('id', ride.customer_id).maybeSingle(),
      ride.driver_id
        ? supabase.from('panel_driver_profiles').select('id, full_name, phone').eq('id', ride.driver_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    const cust = custRes.data as { full_name: string; phone: string | null } | null;
    const drv = driverRes.data as { id: string; full_name: string; phone: string | null } | null;
    return {
      ride,
      transitions: (transitionsRes.data as RideTransition[]) ?? [],
      pricing: (pricingRes.data as RidePricingSnapshot) ?? null,
      customerInfo: cust ? { name: cust.full_name, phone: cust.phone } : null,
      driverInfo: drv ? { id: drv.id, name: drv.full_name, phone: drv.phone } : null,
    };
  },

  /** A driver for marketing: no wallet, files, selfies, contract, identity or earnings. */
  async getDriverDetail(driverId: string): Promise<PanelDriverDetail> {
    const supabase = getSupabaseClient();
    const profileRes = await supabase.from('panel_driver_profiles').select('*').eq('id', driverId).single();
    if (profileRes.error) throw profileRes.error;
    const profile = profileRes.data as PanelDriverRow;

    const [docsRes, eventsRes, churnRes] = await Promise.all([
      supabase.from('panel_driver_documents').select('*').eq('driver_id', driverId)
        .order('uploaded_at', { ascending: false }).limit(100),
      // driver_score_events.driver_id references users(id): it is the profile's user_id, not its id.
      supabase.from('driver_score_events').select('*').eq('driver_id', profile.user_id)
        .order('created_at', { ascending: false }).limit(20),
      supabase.from('panel_driver_churn_risk').select('*').eq('driver_profile_id', driverId).maybeSingle(),
    ]);
    // The most recent document per type, as the admin page shows (re-uploads leave old rows).
    const latest = new Map<string, PanelDriverDocument>();
    for (const doc of (docsRes.data as PanelDriverDocument[]) ?? []) {
      if (!latest.has(doc.document_type)) latest.set(doc.document_type, doc);
    }
    return {
      profile,
      documents: Array.from(latest.values()),
      scoreEvents: (eventsRes.data as DriverScoreEvent[]) ?? [],
      churn: (churnRes.data as PanelChurnRisk) ?? null,
    };
  },

  /** A user for marketing: no wallet, transfers or penalties. */
  async getUserDetail(userId: string): Promise<PanelUserDetail> {
    const supabase = getSupabaseClient();
    const [userRes, ridesRes] = await Promise.all([
      supabase.from('users').select('*').eq('id', userId).single(),
      supabase.from('panel_rides').select('status, final_fare_cup').eq('customer_id', userId).limit(10000),
    ]);
    if (userRes.error) throw userRes.error;
    const rides = (ridesRes.data ?? []) as Array<{ status: RideStatus; final_fare_cup: number | null }>;
    const completed = rides.filter((r) => r.status === 'completed');
    return {
      user: userRes.data as User,
      ridesAsCustomer: rides.length,
      completedAsCustomer: completed.length,
      canceledAsCustomer: rides.filter((r) => r.status === 'canceled').length,
      totalSpentCup: completed.reduce((sum, r) => sum + (r.final_fare_cup ?? 0), 0),
    };
  },

  /** Disputes without evidence, refunds or admin notes. */
  async getDisputes(params?: { status?: string; limit?: number }): Promise<PanelDispute[]> {
    const supabase = getSupabaseClient();
    let query = supabase.from('panel_ride_disputes').select('*')
      .order('created_at', { ascending: false }).limit(params?.limit ?? 50);
    if (params?.status) query = query.eq('status', params.status);
    const { data, error } = await query;
    if (error) throw error;
    return data as PanelDispute[];
  },

  /** Incident reports without evidence or resolution notes. */
  async getIncidents(status?: string, page = 0, pageSize = 20): Promise<PanelIncident[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    let query = supabase.from('panel_incident_reports').select('*')
      .order('created_at', { ascending: false }).range(from, from + pageSize - 1);
    if (status && status !== 'all') query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    return data as PanelIncident[];
  },

  async getIncidentDetail(id: string): Promise<PanelIncidentDetail | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('panel_incident_reports').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const incident = data as PanelIncident;

    const userIds = [incident.reported_by, incident.against_user_id, incident.resolved_by]
      .filter((v): v is string => Boolean(v));
    const userMap: Record<string, { name: string; phone: string }> = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase.from('users').select('id, full_name, phone').in('id', userIds);
      for (const u of (users ?? []) as { id: string; full_name: string; phone: string }[]) {
        userMap[u.id] = { name: u.full_name, phone: u.phone };
      }
    }
    let ride: PanelIncidentDetail['ride'] = null;
    if (incident.ride_id) {
      const { data: r } = await supabase.from('panel_rides')
        .select('id, status, pickup_address, dropoff_address').eq('id', incident.ride_id).maybeSingle();
      ride = (r as PanelIncidentDetail['ride']) ?? null;
    }
    let review: PanelIncidentDetail['review'] = null;
    if (incident.type === 'review_abuse' && incident.review_id) {
      const { data: rev } = await supabase.from('reviews')
        .select('id, rating, comment, is_visible, created_at').eq('id', incident.review_id).maybeSingle();
      review = (rev as PanelIncidentDetail['review']) ?? null;
    }
    return {
      incident,
      reporter: userMap[incident.reported_by] ?? null,
      against: incident.against_user_id ? (userMap[incident.against_user_id] ?? null) : null,
      resolver: incident.resolved_by ? (userMap[incident.resolved_by] ?? null) : null,
      ride,
      review,
    };
  },

  /** The "Fallas del producto" section of Reportes (00663). */
  async getProductFailures(days: number): Promise<ProductFailures> {
    const { data, error } = await getSupabaseClient().rpc('get_product_failures', { p_days: days });
    if (error) throw error;
    return parseProductFailures(data);
  },
};
