import { useState, useEffect, useMemo } from 'react';
import { getSupabaseClient } from '@tricigo/api';
import { isPackageCompatible, type PackageSpecs, type VehicleCargoCapabilities, type CompatibilityResult } from '@tricigo/utils';
import type { VehicleType, PackageCategory } from '@tricigo/types';

interface VehicleCapsSummary {
  type: VehicleType;
  maxWeightKg: number | null;
  maxLengthCm: number | null;
  maxWidthCm: number | null;
  maxHeightCm: number | null;
  acceptedCategories: PackageCategory[];
  availableCount: number;
}

interface DeliveryVehicleOption {
  type: VehicleType;
  available: number;
  compatibility: CompatibilityResult;
  caps: VehicleCapsSummary;
}

/**
 * Fetch aggregated cargo capabilities by vehicle type
 * and check compatibility against the client's package specs.
 */
export function useDeliveryVehicles(packageSpecs: PackageSpecs) {
  const [vehicleCaps, setVehicleCaps] = useState<VehicleCapsSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function fetchCaps() {
      try {
        const supabase = getSupabaseClient();

        // Get all active vehicles that accept cargo, grouped by type
        const { data, error: fetchError } = await supabase
          .from('vehicles')
          .select('type, max_cargo_weight_kg, max_cargo_length_cm, max_cargo_width_cm, max_cargo_height_cm, accepted_cargo_categories')
          .eq('accepts_cargo', true)
          .eq('is_active', true);

        if (fetchError) throw new Error(fetchError.message);
        if (!mounted) return;

        // Aggregate by type
        const byType = new Map<VehicleType, VehicleCapsSummary>();

        for (const v of data ?? []) {
          const existing = byType.get(v.type as VehicleType);
          if (!existing) {
            byType.set(v.type as VehicleType, {
              type: v.type as VehicleType,
              maxWeightKg: v.max_cargo_weight_kg ?? null,
              maxLengthCm: v.max_cargo_length_cm ?? null,
              maxWidthCm: v.max_cargo_width_cm ?? null,
              maxHeightCm: v.max_cargo_height_cm ?? null,
              acceptedCategories: (v.accepted_cargo_categories as PackageCategory[]) ?? [],
              availableCount: 1,
            });
          } else {
            existing.availableCount += 1;
            // Take the max of each dimension across all vehicles of this type
            if (v.max_cargo_weight_kg != null) {
              existing.maxWeightKg = Math.max(existing.maxWeightKg ?? 0, v.max_cargo_weight_kg);
            }
            if (v.max_cargo_length_cm != null) {
              existing.maxLengthCm = Math.max(existing.maxLengthCm ?? 0, v.max_cargo_length_cm);
            }
            if (v.max_cargo_width_cm != null) {
              existing.maxWidthCm = Math.max(existing.maxWidthCm ?? 0, v.max_cargo_width_cm);
            }
            if (v.max_cargo_height_cm != null) {
              existing.maxHeightCm = Math.max(existing.maxHeightCm ?? 0, v.max_cargo_height_cm);
            }
            // Union of accepted categories
            const cats = new Set([...existing.acceptedCategories, ...((v.accepted_cargo_categories as PackageCategory[]) ?? [])]);
            existing.acceptedCategories = Array.from(cats);
          }
        }

        setVehicleCaps(Array.from(byType.values()));
        setError(null);
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Error fetching vehicle capabilities');
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    fetchCaps();
    return () => { mounted = false; };
  }, []);

  // All 3 vehicle types, with compatibility check
  const options: DeliveryVehicleOption[] = useMemo(() => {
    const allTypes: VehicleType[] = ['moto', 'triciclo', 'auto'];

    return allTypes.map((type) => {
      const caps = vehicleCaps.find((c) => c.type === type);

      if (!caps) {
        return {
          type,
          available: 0,
          compatibility: { compatible: false, reason: 'no_vehicles_available' },
          caps: {
            type,
            maxWeightKg: null,
            maxLengthCm: null,
            maxWidthCm: null,
            maxHeightCm: null,
            acceptedCategories: [],
            availableCount: 0,
          },
        };
      }

      const compatibility = isPackageCompatible(packageSpecs, {
        type: caps.type,
        maxWeightKg: caps.maxWeightKg,
        maxLengthCm: caps.maxLengthCm,
        maxWidthCm: caps.maxWidthCm,
        maxHeightCm: caps.maxHeightCm,
        acceptedCategories: caps.acceptedCategories,
        availableCount: caps.availableCount,
      });

      return {
        type,
        available: caps.availableCount,
        compatibility,
        caps,
      };
    });
  }, [vehicleCaps, packageSpecs]);

  return { options, loading, error };
}
