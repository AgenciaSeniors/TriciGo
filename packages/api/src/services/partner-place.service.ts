import { getSupabaseClient } from '../client';
import type { PartnerPlace, PartnerDiscount } from '@tricigo/types';

/**
 * A partner place as the admin panel sees it: the public shape plus how the
 * deal is actually performing.
 *
 * Not in `@tricigo/types` on purpose — this is admin-only and arrives from
 * `admin_list_partner_places`, never from the passenger-facing RPCs.
 */
export interface AdminPartnerPlace {
  id: string;
  name: string;
  category: string;
  address: string | null;
  municipality: string | null;
  province: string | null;
  photo_url: string | null;
  tagline: string | null;
  discount_percent: number;
  latitude: number;
  longitude: number;
  radius_m: number;
  is_active: boolean;
  valid_until: string | null;
  phone: string | null;
  hours: string | null;
  created_at: string;
  /** Completed rides that ended at this place. */
  rides_count: number;
  /** CUP the platform has given up on this deal. What it costs, in one number. */
  discount_given_cup: number;
}

export interface AdminPartnerPlaceInput {
  id?: string | null;
  name: string;
  category: string;
  latitude: number;
  longitude: number;
  discount_percent: number;
  tagline?: string | null;
  photo_url?: string | null;
  address?: string | null;
  municipality?: string | null;
  province?: string | null;
  phone?: string | null;
  hours?: string | null;
  radius_m: number;
  is_active: boolean;
  valid_until?: string | null;
}

/**
 * Partner places and the fare discounts they carry.
 *
 * Read paths (`getNearby`, `getDiscountForDropoff`) swallow errors and fall
 * back to "nothing here". That is deliberate: migrations land in git before
 * anyone applies them to production, so the RPC is legitimately missing for a
 * while. A missing carousel is invisible; a home screen that crashes — or a
 * fare estimate that never resolves — is not.
 *
 * Admin paths throw. An admin staring at an empty table has to know the call
 * failed rather than believe there are no partner places.
 */
export const partnerPlaceService = {
  async getNearby(latitude: number, longitude: number, limit = 10): Promise<PartnerPlace[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_nearby_partner_places', {
      p_lat: latitude,
      p_lng: longitude,
      p_limit: limit,
    });
    if (error) return [];
    return (data ?? []) as PartnerPlace[];
  },

  /**
   * What the passenger would save by ending the ride at these coordinates.
   *
   * Display only. The charged amount is computed server-side from the ride's
   * dropoff; this call exists so the price on screen matches it before the
   * passenger confirms.
   */
  async getDiscountForDropoff(
    latitude: number,
    longitude: number,
    fareCup: number,
  ): Promise<PartnerDiscount> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_partner_discount_for_dropoff', {
      p_lat: latitude,
      p_lng: longitude,
      p_fare_cup: fareCup,
    });
    // A null payload must not read as a discount: the server is the authority
    // on whether one applies, and silence is not a yes.
    if (error || !data) return { found: false };
    return data as PartnerDiscount;
  },

  // ── Admin ───────────────────────────────────────────────────────────
  async adminList(): Promise<AdminPartnerPlace[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_list_partner_places', {});
    if (error) throw error;
    return (data ?? []) as AdminPartnerPlace[];
  },

  async adminUpsert(input: AdminPartnerPlaceInput): Promise<string> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_upsert_partner_place', {
      p_id: input.id ?? null,
      p_name: input.name,
      p_category: input.category,
      p_lat: input.latitude,
      p_lng: input.longitude,
      p_discount_percent: input.discount_percent,
      p_tagline: input.tagline || null,
      p_photo_url: input.photo_url || null,
      p_address: input.address || null,
      p_municipality: input.municipality || null,
      p_province: input.province || null,
      p_phone: input.phone || null,
      p_hours: input.hours || null,
      p_radius_m: input.radius_m,
      p_is_active: input.is_active,
      p_valid_until: input.valid_until || null,
    });
    if (error) throw error;
    return String(data);
  },
};
