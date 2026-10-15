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
  LostItem,
  LostItemStatus,
  PaymentMethod,
  RideDispute,
  RidePricingSnapshot,
  RideStatus,
  RideTransition,
  ServiceTypeSlug,
  User,
  VehicleType,
} from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { applyRideListFilters, escapeLikePattern, type RideListFilters } from './_search';

/** Who canceled a ride: unknown is a canceler who is none of the others (00663). */
export type CanceledByRole = 'customer' | 'driver' | 'staff' | 'system' | 'unknown';

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
  wait_time_minutes: number | null;
  wait_time_charge_cup: number | null;
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
  rating_avg: number;
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

/** The rides-list filters, the same as the admin list's. */
export type PanelRideFilters = RideListFilters;

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
  /** The latest snapshot (final when there is one, else the estimate); null when there is none. */
  pricing: RidePricingSnapshot | null;
  /** The snapshot read failed: pricing is null, and the page says "No disponible". */
  pricingUnavailable: boolean;
  /** null when the lookup found nobody or failed: the page shows '—'. */
  customerInfo: { name: string; phone: string | null } | null;
  /** null when the ride has no driver, or when the lookup found nobody or failed. */
  driverInfo: { id: string; name: string; phone: string | null } | null;
}

export interface PanelDriverDocument {
  id: string;
  driver_id: string;
  document_type: string;
  uploaded_at: string;
  is_verified: boolean;
  verified_at: string | null;
  rejection_reason: string | null;
}

/** A driver who never completed a ride has this many days_since_last_ride (COALESCE in the view). */
export const CHURN_NEVER_RODE_DAYS = 999;

export interface PanelChurnRisk {
  driver_profile_id: string;
  /** CHURN_NEVER_RODE_DAYS when the driver never completed a ride. */
  days_since_last_ride: number | null;
  churn_risk_score: number | null;
  risk_level: string | null;
}

export interface PanelDriverDetail {
  profile: PanelDriverRow;
  documents: PanelDriverDocument[];
  scoreEvents: DriverScoreEvent[];
  /** null when the driver has no churn row, or when the read failed (see churnUnavailable). */
  churn: PanelChurnRisk | null;
  /** The churn read failed: the page says "No disponible". */
  churnUnavailable: boolean;
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
export type PanelLostItem = WithHidden<LostItem, 'admin_notes' | 'return_location' | 'return_notes'>;

/** panel_lost_items, column by column: every lost_items column but the notes and the return arrangements (00663). */
const PANEL_LOST_ITEM_COLUMNS = 'id, ride_id, reporter_id, driver_id, description, category, photo_urls, status, driver_response, driver_found, return_fee_cup, resolved_by, created_at, updated_at, resolved_at';

export interface PanelIncidentDetail {
  incident: PanelIncident;
  /** null when the lookup found nobody or failed: the page shows the id instead. */
  reporter: { name: string; phone: string } | null;
  against: { name: string; phone: string } | null;
  resolver: { name: string; phone: string } | null;
  /** null when the incident has no ride, or when the read found nothing or failed (see rideUnavailable). */
  ride: { id: string; status: string; pickup_address: string; dropoff_address: string } | null;
  /** The ride summary read failed: ride is null, and the page says "No disponible". */
  rideUnavailable: boolean;
  /** null unless the incident reports a review and the read found it (see reviewUnavailable). */
  review: { id: string; rating: number; comment: string | null; is_visible: boolean; created_at: string } | null;
  /** The reported review read failed: review is null, and the page says "No disponible". */
  reviewUnavailable: boolean;
}

/** PostgREST answers 22P02 (invalid_text_representation) for an id that is not a uuid. */
const INVALID_TEXT_REPRESENTATION = '22P02';

/**
 * The main row of a detail page, read with maybeSingle(): null when there is no row or the id is
 * not a uuid (the page then says it was not found); any other error is thrown.
 */
function mainRow<T>(res: { data: unknown; error: { code?: string } | null }): T | null {
  if (res.error) {
    if (res.error.code === INVALID_TEXT_REPRESENTATION) return null;
    throw res.error;
  }
  return (res.data as T | null) ?? null;
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
  /** requests: how many ride endpoints asked for the name. */
  placesNotFound: { name: string; requests: number; lastSeen: string; imported: number }[];
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
      .map((p) => ({ name: p.name as string, requests: num(p.requests), lastSeen: str(p.last_seen) ?? '', imported: num(p.imported) })),
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
    const query = applyRideListFilters(
      supabase
        .from('panel_rides')
        .select('*')
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1),
      filters,
    );

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

  /**
   * A ride for marketing: no chat, no delivery code or photos, no coordinates. null when there is no
   * such ride. The timeline must load (an empty one would claim the ride never moved); the price
   * snapshot and the two people are extras the page can do without.
   */
  async getRideDetail(rideId: string): Promise<PanelRideDetail | null> {
    const supabase = getSupabaseClient();
    const [rideRes, transitionsRes, pricingRes] = await Promise.all([
      supabase.from('panel_rides').select('*').eq('id', rideId).maybeSingle(),
      supabase.from('ride_transitions').select('*').eq('ride_id', rideId).order('created_at', { ascending: true }),
      supabase.from('ride_pricing_snapshots').select('*').eq('ride_id', rideId)
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    const ride = mainRow<PanelRide>(rideRes);
    if (!ride) return null;
    if (transitionsRes.error) throw transitionsRes.error;

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
      pricing: pricingRes.error ? null : ((pricingRes.data as RidePricingSnapshot | null) ?? null),
      pricingUnavailable: pricingRes.error != null,
      customerInfo: cust ? { name: cust.full_name, phone: cust.phone } : null,
      driverInfo: drv ? { id: drv.id, name: drv.full_name, phone: drv.phone } : null,
    };
  },

  /**
   * A driver for marketing: no wallet, files, selfies, contract, identity or earnings. null when
   * there is no such driver. Documents and score events must load (an empty list would claim the
   * driver has none); churn risk is an extra the page can do without.
   */
  async getDriverDetail(driverId: string): Promise<PanelDriverDetail | null> {
    const supabase = getSupabaseClient();
    const profile = mainRow<PanelDriverRow>(
      await supabase.from('panel_driver_profiles').select('*').eq('id', driverId).maybeSingle(),
    );
    if (!profile) return null;

    const [docsRes, eventsRes, churnRes] = await Promise.all([
      supabase.from('panel_driver_documents').select('*').eq('driver_id', driverId)
        .order('uploaded_at', { ascending: false }).limit(100),
      // driver_score_events.driver_id references users(id): it is the profile's user_id, not its id.
      supabase.from('driver_score_events').select('*').eq('driver_id', profile.user_id)
        .order('created_at', { ascending: false }).limit(20),
      supabase.from('panel_driver_churn_risk').select('*').eq('driver_profile_id', driverId).maybeSingle(),
    ]);
    if (docsRes.error) throw docsRes.error;
    if (eventsRes.error) throw eventsRes.error;
    // The most recent document per type, as the admin page shows (re-uploads leave old rows).
    const latest = new Map<string, PanelDriverDocument>();
    for (const doc of (docsRes.data as PanelDriverDocument[]) ?? []) {
      if (!latest.has(doc.document_type)) latest.set(doc.document_type, doc);
    }
    return {
      profile,
      documents: Array.from(latest.values()),
      scoreEvents: (eventsRes.data as DriverScoreEvent[]) ?? [],
      churn: churnRes.error ? null : ((churnRes.data as PanelChurnRisk | null) ?? null),
      churnUnavailable: churnRes.error != null,
    };
  },

  /**
   * A user for marketing: no wallet, transfers or penalties. null when there is no such user. The
   * rides read must load: without it the page would show 0 rides as if that were true.
   */
  async getUserDetail(userId: string): Promise<PanelUserDetail | null> {
    const supabase = getSupabaseClient();
    const [userRes, ridesRes] = await Promise.all([
      supabase.from('users').select('*').eq('id', userId).maybeSingle(),
      supabase.from('panel_rides').select('status, final_fare_cup').eq('customer_id', userId).limit(10000),
    ]);
    const user = mainRow<User>(userRes);
    if (!user) return null;
    if (ridesRes.error) throw ridesRes.error;
    const rides = (ridesRes.data ?? []) as Array<{ status: RideStatus; final_fare_cup: number | null }>;
    const completed = rides.filter((r) => r.status === 'completed');
    return {
      user,
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

  /**
   * An incident for marketing: no evidence or resolution notes. null when there is no such incident.
   * The names, the ride summary and the reported review are extras the page can do without; a
   * failed ride or review read is flagged so the page says "No disponible" instead of "no ride".
   */
  async getIncidentDetail(id: string): Promise<PanelIncidentDetail | null> {
    const supabase = getSupabaseClient();
    const incident = mainRow<PanelIncident>(
      await supabase.from('panel_incident_reports').select('*').eq('id', id).maybeSingle(),
    );
    if (!incident) return null;

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
    let rideUnavailable = false;
    if (incident.ride_id) {
      const { data: r, error: rideError } = await supabase.from('panel_rides')
        .select('id, status, pickup_address, dropoff_address').eq('id', incident.ride_id).maybeSingle();
      rideUnavailable = rideError != null;
      ride = rideError ? null : ((r as PanelIncidentDetail['ride']) ?? null);
    }
    let review: PanelIncidentDetail['review'] = null;
    let reviewUnavailable = false;
    if (incident.type === 'review_abuse' && incident.review_id) {
      const { data: rev, error: reviewError } = await supabase.from('reviews')
        .select('id, rating, comment, is_visible, created_at').eq('id', incident.review_id).maybeSingle();
      reviewUnavailable = reviewError != null;
      review = reviewError ? null : ((rev as PanelIncidentDetail['review']) ?? null);
    }
    return {
      incident,
      reporter: userMap[incident.reported_by] ?? null,
      against: incident.against_user_id ? (userMap[incident.against_user_id] ?? null) : null,
      resolver: incident.resolved_by ? (userMap[incident.resolved_by] ?? null) : null,
      ride,
      rideUnavailable,
      review,
      reviewUnavailable,
    };
  },

  /**
   * Lost items without the internal notes or the return arrangements (panel_lost_items, 00663).
   * Mirrors lostItemService.getAllLostItems: marketing has no policy on lost_items itself.
   */
  async getLostItems(options: { status?: LostItemStatus; limit?: number } = {}): Promise<PanelLostItem[]> {
    const { status, limit = 100 } = options;
    let query = getSupabaseClient().from('panel_lost_items').select(PANEL_LOST_ITEM_COLUMNS);
    if (status) query = query.eq('status', status);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []) as PanelLostItem[];
  },

  /** The "Fallas del producto" section of Reportes (00663). */
  async getProductFailures(days: number): Promise<ProductFailures> {
    const { data, error } = await getSupabaseClient().rpc('get_product_failures', { p_days: days });
    if (error) throw error;
    return parseProductFailures(data);
  },
};
