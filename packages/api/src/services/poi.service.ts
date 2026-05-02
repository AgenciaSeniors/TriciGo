import { getSupabaseClient } from '../client';

/**
 * Unified TriciGo POI category. The migration backfilled these from
 * OSM (category, subcategory) pairs; the monthly Foursquare/Overture
 * sync refines them. Keep in sync with `scripts/sync-pois/categories.json`
 * and `supabase/migrations/00248_pois_multi_source.sql`.
 */
export type TriciGoCategory =
  | 'hospital'
  | 'pharmacy'
  | 'school'
  | 'gov'
  | 'hotel'
  | 'restaurant'
  | 'paladar'
  | 'cafe'
  | 'bar'
  | 'supermarket'
  | 'shop'
  | 'bank'
  | 'atm'
  | 'gas_station'
  | 'museum'
  | 'park'
  | 'beach'
  | 'embassy'
  | 'religion'
  | 'transport'
  | 'other';

export const TRICIGO_CATEGORIES: TriciGoCategory[] = [
  'hospital', 'pharmacy', 'school', 'gov', 'hotel', 'restaurant', 'paladar',
  'cafe', 'bar', 'supermarket', 'shop', 'bank', 'atm', 'gas_station',
  'museum', 'park', 'beach', 'embassy', 'religion', 'transport', 'other',
];

export type PoiSource = 'admin' | 'osm' | 'overture' | 'foursquare' | 'merged';

export interface Poi {
  id: number;
  name: string;
  category: string | null;
  subcategory: string | null;
  tricigo_category: TriciGoCategory | null;
  address: string | null;
  municipality: string | null;
  province: string | null;
  latitude: number;
  longitude: number;
  source: PoiSource;
  source_ids: Record<string, string>;
  phone: string | null;
  website: string | null;
  socials: Record<string, string> | null;
  hours: string | null;
  confidence: number;
  is_admin: boolean;
  is_active: boolean;
  importance: number | null;
  synced_at: string | null;
  updated_at: string;
}

export interface PoiInput {
  name: string;
  tricigo_category: TriciGoCategory;
  latitude: number;
  longitude: number;
  address?: string | null;
  municipality?: string | null;
  province?: string | null;
  phone?: string | null;
  website?: string | null;
  hours?: string | null;
}

export interface PoiListFilters {
  search?: string;
  category?: TriciGoCategory | 'all';
  source?: PoiSource | 'all';
  municipality?: string;
  onlyAdmin?: boolean;
  onlyActive?: boolean;
}

export interface PoiListResult {
  rows: Poi[];
  total: number;
}

const PAGE_SIZE = 50;

export const poiService = {
  /**
   * List POIs for the admin table. Returns up to PAGE_SIZE rows + the
   * total matching count (so the table can render pagination). Wraps the
   * `admin_list_pois` RPC, which embeds the admin-role guard.
   */
  async list(page = 0, filters: PoiListFilters = {}): Promise<PoiListResult> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_list_pois', {
      p_search:       filters.search?.trim() || null,
      p_category:     filters.category && filters.category !== 'all' ? filters.category : null,
      p_source:       filters.source   && filters.source   !== 'all' ? filters.source   : null,
      p_municipality: filters.municipality || null,
      p_only_admin:   filters.onlyAdmin === true,
      p_only_active:  filters.onlyActive !== false,
      p_page:         page,
      p_page_size:    PAGE_SIZE,
    });
    if (error) throw error;
    const rows = (data ?? []) as Array<Poi & { total_count: number }>;
    const total = rows.length > 0 ? Number(rows[0]!.total_count) : 0;
    // Strip the join-broadcast `total_count` column so consumers see Poi[]
    return {
      rows: rows.map(({ total_count: _omit, ...row }) => row as Poi),
      total,
    };
  },

  /** Get a single POI by id. */
  async getById(id: number): Promise<Poi | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_get_poi', { p_id: id });
    if (error) throw error;
    const rows = (data ?? []) as Poi[];
    return rows[0] ?? null;
  },

  /**
   * Create a new admin-curated POI. Returns the inserted row id.
   * Defaults `is_admin=true` so the monthly sync never overwrites it.
   */
  async create(input: PoiInput): Promise<number> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_create_poi', {
      p_name:             input.name,
      p_tricigo_category: input.tricigo_category,
      p_lat:              input.latitude,
      p_lng:              input.longitude,
      p_address:          input.address || null,
      p_municipality:     input.municipality || null,
      p_province:         input.province || null,
      p_phone:            input.phone || null,
      p_website:          input.website || null,
      p_hours:            input.hours || null,
    });
    if (error) throw error;
    return Number(data);
  },

  /**
   * Partial update. Pass only the fields you want to change. Touching ANY
   * field flips `is_admin=true` so subsequent syncs won't overwrite the row.
   */
  async update(id: number, input: Partial<PoiInput>): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('admin_update_poi', {
      p_id:               id,
      p_name:             input.name ?? null,
      p_tricigo_category: input.tricigo_category ?? null,
      p_lat:              input.latitude ?? null,
      p_lng:              input.longitude ?? null,
      p_address:          input.address ?? null,
      p_municipality:     input.municipality ?? null,
      p_province:         input.province ?? null,
      p_phone:            input.phone ?? null,
      p_website:          input.website ?? null,
      p_hours:            input.hours ?? null,
      p_is_active:        null,
      p_unlock_for_sync:  false,
    });
    if (error) throw error;
  },

  /** Soft-deactivate a POI (search excludes is_active=false rows). */
  async deactivate(id: number): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('admin_update_poi', {
      p_id:        id,
      p_is_active: false,
    });
    if (error) throw error;
  },

  /** Re-activate a previously deactivated POI. */
  async activate(id: number): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('admin_update_poi', {
      p_id:        id,
      p_is_active: true,
    });
    if (error) throw error;
  },

  /**
   * Unlock a POI so the monthly sync can refresh it. Use when admin
   * just wanted to fix a typo and is happy for upstream data to take
   * over again.
   */
  async unlock(id: number): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('admin_update_poi', {
      p_id:              id,
      p_unlock_for_sync: true,
    });
    if (error) throw error;
  },
};
