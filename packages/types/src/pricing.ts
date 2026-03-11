// ============================================================
// TriciGo — Pricing, Zone & Service Configuration Types
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
  /** Base fare in CUP whole pesos */
  base_fare_cup: number;
  /** Rate per km in CUP whole pesos */
  per_km_rate_cup: number;
  /** Rate per minute in CUP whole pesos */
  per_minute_rate_cup: number;
  /** Minimum fare in CUP whole pesos */
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
  /** Default base fare in centavos */
  base_fare_cup: number;
  /** Default per km rate in centavos */
  per_km_rate_cup: number;
  /** Default per minute rate in centavos */
  per_minute_rate_cup: number;
  /** Default minimum fare in centavos */
  min_fare_cup: number;
  max_passengers: number;
  icon_name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type SurgeType = 'none' | 'time_based' | 'demand' | 'combined';

/** Fare estimate returned to the client before ride request */
export interface FareEstimate {
  service_type: ServiceTypeSlug;
  /** Fare in CUP whole pesos */
  estimated_fare_cup: number;
  /** Fare in TRC centavos (CUP converted at exchange rate) */
  estimated_fare_trc: number;
  estimated_distance_m: number;
  estimated_duration_s: number;
  surge_multiplier: number;
  surge_type: SurgeType;
  pricing_rule_id: string;
  /** Effective per-km rate used (CUP whole pesos) */
  per_km_rate_cup: number;
  /** Exchange rate used: 1 USD = X CUP */
  exchange_rate_usd_cup: number;
}

export interface FeatureFlag {
  id: string;
  key: string;
  value: boolean;
  description: string;
  updated_at: string;
}
