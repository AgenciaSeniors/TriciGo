import { useState, useEffect, useRef, useCallback } from 'react';
import { rideService } from '@tricigo/api';
import { getSupabaseClient } from '@tricigo/api';
import type { SurgeZone } from '@tricigo/types';

/** Surge zone enriched with its geographic boundary */
export interface SurgeZoneWithBoundary extends SurgeZone {
  /** GeoJSON polygon coordinates from the parent zone */
  boundary: { type: 'Polygon'; coordinates: number[][][] } | null;
  /** Human-readable zone name */
  zone_name: string | null;
}

const POLL_INTERVAL = 60_000; // 60s

/**
 * Polls active surge zones and fetches their geographic boundaries.
 * Only active when `enabled` is true (driver online, no active ride).
 */
export function useSurgeZones(enabled: boolean): SurgeZoneWithBoundary[] {
  const [zones, setZones] = useState<SurgeZoneWithBoundary[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSurgeZones = useCallback(async () => {
    try {
      // 1. Get active surge zones
      const activeSurges = await rideService.getActiveSurges();
      if (!activeSurges.length) {
        setZones([]);
        return;
      }

      // 2. Get boundaries from parent zones table
      const zoneIds = activeSurges
        .map((s) => s.zone_id)
        .filter((id): id is string => id !== null);

      let boundaryMap = new Map<string, { boundary: any; name: string }>();

      if (zoneIds.length > 0) {
        const supabase = getSupabaseClient();
        const { data: parentZones } = await supabase
          .from('zones')
          .select('id, name, boundary')
          .in('id', zoneIds);

        if (parentZones) {
          for (const z of parentZones) {
            boundaryMap.set(z.id, { boundary: z.boundary, name: z.name });
          }
        }
      }

      // 3. Combine surge zones with boundaries
      const enriched: SurgeZoneWithBoundary[] = activeSurges.map((surge) => {
        const parent = surge.zone_id ? boundaryMap.get(surge.zone_id) : null;
        return {
          ...surge,
          boundary: parent?.boundary ?? null,
          zone_name: parent?.name ?? surge.reason,
        };
      });

      // Only keep zones with valid boundaries for rendering
      setZones(enriched.filter((z) => z.boundary !== null));
    } catch {
      // Silent — surge zones are optional/cosmetic
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setZones([]);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Initial fetch
    fetchSurgeZones();

    // Poll
    intervalRef.current = setInterval(fetchSurgeZones, POLL_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, fetchSurgeZones]);

  return zones;
}
