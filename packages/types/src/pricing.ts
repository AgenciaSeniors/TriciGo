// ============================================================
// TriciGo — Pricing, Zone & Service Configuration Types
//
// Currency: 1 TRC = 1 CUP. All fares stored in whole units.
// USD conversion via eltoque exchange rate.
// ============================================================

import type { ServiceTypeSlug, ZoneType } from './enums';

export interface GeoJSONPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

export interface Zone {
  id: string;
  name: string;
  type: ZoneType;
  boundary: GeoJSONPolygon;
  surge_multiplier: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PricingRule {
  id: string;
  zone_id: string | null;
  service_type: ServiceTypeSlug;
  /** Base fare in CUP/TRC whole units */
  base_fare_cup: number;
  /** Rate per km in CUP/TRC whole units */
  per_km_rate_cup: number;
  /** Rate per minute in CUP/TRC whole units */
  per_minute_rate_cup: number;
  /** Minimum fare in CUP/TRC whole units */
  min_fare_cup: number;
  /** Demand/supply ratio that triggers surge pricing */
  surge_threshold: number | null;
  /** Maximum allowed surge multiplier */
  max_surge_multiplier: number | null;
  /** Time window for time-based pricing (HH:MM format) */
  time_window_start: string | null;
  time_window_end: string | null;
  /** Days of week (0=Sun, 6=Sat) */
  day_of_week: number[] | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ServiceTypeConfig {
  id: string;
  slug: ServiceTypeSlug;
  name_es: string;
  name_en: string;
  /** Default base fare in CUP/TRC whole units */
  base_fare_cup: number;
  /** Default per km rate in CUP/TRC whole units */
  per_km_rate_cup: number;
  /** Default per minute rate in CUP/TRC whole units */
  per_minute_rate_cup: number;
  /** Default minimum fare in CUP/TRC whole units */
  min_fare_cup: number;
  max_passengers: number;
  icon_name: string;
  is_active: boolean;
  /** Rate per minute of wait time after free period (CUP/TRC) */
  per_wait_minute_rate_cup: number;
  /** Free wait time in minutes before charges begin */
  free_wait_minutes: number;
  created_at: string;
  updated_at: string;
}

export type SurgeType = 'none' | 'time_based' | 'demand' | 'combined' | 'weather';

/** Fare estimate returned to the client before ride request */
export interface FareEstimate {
  service_type: ServiceTypeSlug;
  /** Fare in CUP/TRC whole units (1 TRC = 1 CUP) */
  estimated_fare_cup: number;
  /** Fare in TRC whole units (same as CUP since 1:1) */
  estimated_fare_trc: number;
  /** Fare in USD (derived from exchange rate). Optional for Cuba-only MVP. */
  estimated_fare_usd?: number;
  estimated_distance_m: number;
  estimated_duration_s: number;
  surge_multiplier: number;
  surge_type: SurgeType;
  pricing_rule_id: string;
  /** Effective per-km rate used (CUP/TRC whole units) */
  per_km_rate_cup: number;
  /** Effective base fare used (CUP/TRC whole units) */
  base_fare_cup: number;
  /** Effective per-minute rate used (CUP/TRC whole units) */
  per_minute_rate_cup: number;
  /** Whether minimum fare was applied (raw calc was below min) */
  min_fare_applied: boolean;
  /** Exchange rate used: 1 USD = X CUP/TRC (from eltoque) */
  exchange_rate_usd_cup: number;
  /** Minimum expected fare in CUP/TRC (considering traffic variance) */
  fare_range_min_cup: number;
  /** Maximum expected fare in CUP/TRC (considering traffic + surge) */
  fare_range_max_cup: number;
  /** Minimum expected fare in TRC (same as CUP) */
  fare_range_min_trc: number;
  /** Maximum expected fare in TRC (same as CUP) */
  fare_range_max_trc: number;
  /** Minimum expected fare in USD. Optional for Cuba-only MVP. */
  fare_range_min_usd?: number;
  /** Maximum expected fare in USD. Optional for Cuba-only MVP. */
  fare_range_max_usd?: number;
  /** Insurance premium in CUP/TRC (if insurance available) */
  insurance_premium_cup?: number;
  /** Insurance premium in TRC (same as CUP) */
  insurance_premium_trc?: number;
  /** Insurance premium in USD */
  insurance_premium_usd?: number;
  /** Whether trip insurance is available for this service type */
  insurance_available?: boolean;
  /** Insurance coverage description (localized) */
  insurance_coverage_desc?: string;
}

export interface TripInsuranceConfig {
  id: string;
  service_type: ServiceTypeSlug;
  /** Premium as a fraction of the fare (0.05 = 5%) */
  premium_pct: number;
  /** Minimum premium in CUP/TRC (even for very short rides) */
  min_premium_cup: number;
  /** Maximum coverage amount in CUP/TRC */
  max_coverage_cup: number;
  coverage_description_es: string;
  coverage_description_en: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface FeatureFlag {
  id: string;
  key: string;
  value: boolean;
  description: string;
  updated_at: string;
}
