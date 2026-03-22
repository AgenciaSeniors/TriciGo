// ============================================================
// TriciGo — City Service
// City auto-detection by GPS coordinates and city listing.
// ============================================================

import { getSupabaseClient } from '../client';

interface CityRow {
  id: string;
  name: string;
  slug: string;
  center_latitude: number;
  center_longitude: number;
  bounds_ne_lat: number | null;
  bounds_ne_lng: number | null;
  bounds_sw_lat: number | null;
  bounds_sw_lng: number | null;
}

export const cityService = {
  /**
   * Detect the nearest active city for a given GPS coordinate.
   * First checks if the point falls within any city's bounding box,
   * then falls back to nearest city by Euclidean distance.
   */
  async detectCity(
    lat: number,
    lng: number,
  ): Promise<{ id: string; name: string; slug: string } | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('cities')
      .select(
        'id, name, slug, center_latitude, center_longitude, bounds_ne_lat, bounds_ne_lng, bounds_sw_lat, bounds_sw_lng',
      )
      .eq('is_active', true);

    if (error || !data?.length) return null;

    const cities = data as CityRow[];

    // 1) Check if point is inside any city's bounding box
    for (const city of cities) {
      if (
        city.bounds_sw_lat != null &&
        city.bounds_sw_lng != null &&
        city.bounds_ne_lat != null &&
        city.bounds_ne_lng != null &&
        lat >= city.bounds_sw_lat &&
        lat <= city.bounds_ne_lat &&
        lng >= city.bounds_sw_lng &&
        lng <= city.bounds_ne_lng
      ) {
        return { id: city.id, name: city.name, slug: city.slug };
      }
    }

    // 2) Fall back to nearest city by distance to center
    let nearest = cities[0];
    let minDist = Infinity;
    for (const city of cities) {
      const dist = Math.sqrt(
        Math.pow(city.center_latitude - lat, 2) +
          Math.pow(city.center_longitude - lng, 2),
      );
      if (dist < minDist) {
        minDist = dist;
        nearest = city;
      }
    }

    return { id: nearest.id, name: nearest.name, slug: nearest.slug };
  },

  /**
   * Return all active cities, ordered by name.
   */
  async getAllCities(): Promise<
    Array<{ id: string; name: string; slug: string }>
  > {
    const supabase = getSupabaseClient();

    const { data } = await supabase
      .from('cities')
      .select('id, name, slug')
      .eq('is_active', true)
      .order('name');

    return data ?? [];
  },
};
