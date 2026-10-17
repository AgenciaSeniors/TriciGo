import { havanaDayRangeUtc } from '@tricigo/utils';

/** Escape special characters for PostgreSQL ILIKE patterns. */
export function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, '\\$&');
}

/**
 * A ride code as riders and support write it ("F1A2B3C4", "#f1a2b3c4"): the first 8 hex
 * characters of the ride id, lower-cased. null when the text is not one.
 */
export function rideCodePrefix(text: string): string | null {
  const m = text.trim().match(/^#?([0-9a-f]{8})$/i);
  return m ? m[1]!.toLowerCase() : null;
}

/** The filters of the rides list, the same for the admin list (rides) and the panel list (panel_rides). */
export interface RideListFilters {
  status?: string;
  serviceType?: string;
  paymentMethod?: string;
  /** A Havana calendar day, 'YYYY-MM-DD'. */
  dateFrom?: string;
  /** A Havana calendar day, 'YYYY-MM-DD', included. */
  dateTo?: string;
  /** A ride code (see rideCodePrefix) or text to find in the pickup or dropoff address. */
  search?: string;
  cityId?: string;
  /** 'cargo' = shipments, 'passenger' = normal rides. Filtering by service_type cannot isolate
      shipments: a delivery is stored with the chosen vehicle's slug, so it looks like any other
      moto/auto ride. */
  rideMode?: 'passenger' | 'cargo';
}

/** The filter methods applyRideListFilters calls; a Supabase query builder has all of them. */
interface RideListQuery<Q> {
  eq(column: string, value: string): Q;
  gte(column: string, value: string): Q;
  lt(column: string, value: string): Q;
  lte(column: string, value: string): Q;
  or(filters: string): Q;
}

/** Adds the rides-list filters to a query on rides or panel_rides. */
export function applyRideListFilters<Q extends RideListQuery<Q>>(query: Q, filters: RideListFilters): Q {
  let q = query;
  if (filters.status) q = q.eq('status', filters.status);
  if (filters.serviceType) q = q.eq('service_type', filters.serviceType);
  if (filters.rideMode) q = q.eq('ride_mode', filters.rideMode);
  if (filters.paymentMethod) q = q.eq('payment_method', filters.paymentMethod);
  // Date inputs are Havana calendar days ('YYYY-MM-DD'); raw strings would be read as UTC
  // midnight (4-5h off Cuba's day).
  if (filters.dateFrom) q = q.gte('created_at', havanaDayRangeUtc(filters.dateFrom).start.toISOString());
  if (filters.dateTo) q = q.lt('created_at', havanaDayRangeUtc(filters.dateTo).end.toISOString());
  if (filters.search) {
    const code = rideCodePrefix(filters.search);
    if (code) {
      // uuid order is byte order, so every id with this prefix lies in this range.
      q = q
        .gte('id', `${code}-0000-0000-0000-000000000000`)
        .lte('id', `${code}-ffff-ffff-ffff-ffffffffffff`);
    } else {
      const escaped = escapeLikePattern(filters.search);
      q = q.or(`pickup_address.ilike.%${escaped}%,dropoff_address.ilike.%${escaped}%`);
    }
  }
  if (filters.cityId) q = q.eq('city_id', filters.cityId);
  return q;
}
