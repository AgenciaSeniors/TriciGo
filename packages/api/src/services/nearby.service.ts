// ============================================================
// TriciGo — Nearby Vehicle Service
// Find nearby drivers for map display
// ============================================================

import type { NearbyVehicle, VehicleType } from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const nearbyService = {
  /**
   * Find nearby available vehicles for map display.
   * Uses the find_nearby_vehicles RPC (PostGIS proximity query). Signed-in
   * callers only; the server caps the radius at 5 km and the count at 50,
   * leaves out the caller's own vehicle and returns approximate positions
   * with hourly opaque ids (00645).
   */
  async findNearbyVehicles(params: {
    lat: number;
    lng: number;
    vehicleType?: VehicleType | null;
    radiusM?: number;
    limit?: number;
  }): Promise<NearbyVehicle[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('find_nearby_vehicles', {
      p_lat: params.lat,
      p_lng: params.lng,
      p_vehicle_type: params.vehicleType ?? null,
      p_radius_m: params.radiusM ?? 5000,
      p_limit: params.limit ?? 50,
    });
    if (error) throw error;
    // Map RPC column name to type field name
    const vehicles = (Array.isArray(data) ? data : []).map((row: Record<string, unknown>) => ({
      driver_profile_id: row.driver_profile_id as string,
      latitude: row.latitude as number,
      longitude: row.longitude as number,
      heading: (row.heading as number) ?? null,
      vehicle_type: row.vehicle_type as string,
      custom_per_km_rate_cup: (row.custom_per_km_rate_cup as number) ?? null,
    }));
    return vehicles as NearbyVehicle[];
  },

  /**
   * Resolve the offline-map grid cell to download for a GPS point.
   * Returns the cell bounds (clipped to where streets exist) or null when
   * there are no streets nearby. Tolerates the RPC being absent (migration
   * not yet applied) — returns null so the caller silently no-ops and the
   * map falls back to online / ambient cache.
   */
  async getOfflineRegionForPoint(
    lat: number,
    lng: number,
  ): Promise<{ cellKey: string; ne: [number, number]; sw: [number, number] } | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_offline_region_for_point', {
      p_lat: lat,
      p_lng: lng,
    });
    if (error) {
      // Migration not applied yet → behave as "no region".
      if (error.code === '42883' || /does not exist/i.test(error.message ?? '')) {
        return null;
      }
      throw error;
    }
    const row = (Array.isArray(data) ? data[0] : null) as
      | { cell_key: string; sw_lng: number; sw_lat: number; ne_lng: number; ne_lat: number }
      | null
      | undefined;
    if (!row) return null;
    return {
      cellKey: row.cell_key,
      ne: [row.ne_lng, row.ne_lat],
      sw: [row.sw_lng, row.sw_lat],
    };
  },
};
