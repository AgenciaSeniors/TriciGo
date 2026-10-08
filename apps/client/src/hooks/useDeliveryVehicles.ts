import { useState, useEffect, useMemo } from 'react';
import { deliveryService } from '@tricigo/api';
import { isPackageCompatible, type PackageSpecs, type VehicleCargoCapabilities, type CompatibilityResult } from '@tricigo/utils';
import type { VehicleType } from '@tricigo/types';

type VehicleCapsSummary = VehicleCargoCapabilities;

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
        // Per-type capabilities from get_cargo_vehicle_caps (00644): riders no
        // longer read other drivers' vehicles, and the function returns no
        // plate, photo or driver id.
        const caps = await deliveryService.getCargoVehicleCaps();
        if (!mounted) return;
        setVehicleCaps(caps);
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

  // All 4 vehicle types, with compatibility check
  const options: DeliveryVehicleOption[] = useMemo(() => {
    const allTypes: VehicleType[] = ['moto', 'triciclo', 'auto', 'confort'];

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
