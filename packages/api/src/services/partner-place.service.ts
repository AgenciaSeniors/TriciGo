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
    rideMode: 'passenger' | 'cargo' = 'passenger',
  ): Promise<PartnerDiscount> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_partner_discount_for_dropoff', {
      p_lat: latitude,
      p_lng: longitude,
      p_fare_cup: fareCup,
      // 00564: a delivery gets no partner discount. Sent so what is SHOWN
      // matches what the trigger CHARGES — otherwise a delivery would preview a
      // discount and then bill the full fare, which is the one direction this
      // feature must never fail in.
      p_ride_mode: rideMode,
    });
    // A null payload must not read as a discount: the server is the authority
    // on whether one applies, and silence is not a yes.
    if (error || !data) return { found: false };
    return data as PartnerDiscount;
  },

  // ── Admin ───────────────────────────────────────────────────────────

  /**
   * Upload a partner place photo and return its public URL.
   *
   * Goes through the `storage-upload` Edge Function rather than
   * `supabase.storage.upload()`: since the publishable-key migration the
   * Storage service rejects the browser session's JWT as `anon`, so a direct
   * upload fails RLS. The EF authenticates the caller, requires an admin role
   * for this bucket, and writes with service-role. Same route the web avatar
   * takes.
   *
   * Unlike the read paths this THROWS. An upload that fails quietly would
   * leave the admin believing they saved a photo that does not exist.
   *
   * Replacing a photo leaves the previous object orphaned in the bucket. That
   * is deliberate and cheap — small images in a public bucket — and not worth
   * a cleanup job yet.
   */
  async uploadPhoto(file: Blob, placeId?: string | null): Promise<string> {
    const supabase = getSupabaseClient();
    // A brand-new place has no id yet, so fall back to a random one. The EF
    // only requires the `places/` prefix and three segments.
    const id = placeId || crypto.randomUUID();
    const path = `places/${id}/${Date.now()}.jpg`;

    const fd = new FormData();
    fd.append('file', file, 'photo.jpg');
    fd.append('bucket', 'partner-photos');
    fd.append('path', path);
    fd.append('upsert', 'true');
    fd.append('contentType', 'image/jpeg');

    const { data, error } = await supabase.functions.invoke('storage-upload', { body: fd });
    if (error) throw error;
    // The EF answers 200 with an { error } body for authz and MIME rejections,
    // so checking `error` alone would read a 403 as a successful upload.
    const payloadError = (data as { error?: string } | null)?.error;
    if (payloadError) throw new Error(String(payloadError));

    return supabase.storage.from('partner-photos').getPublicUrl(path).data.publicUrl;
  },

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
