import { useState, useEffect } from 'react';
import { generateTestVehicles, stepTestVehicles, type TestVehicle } from '@tricigo/utils';
import type { NearbyVehicle } from '@tricigo/types';

const STEP_INTERVAL_MS = 1000;

/**
 * Pre-launch map QA: returns synthetic vehicles that move around
 * `center` so we can preview how peer markers render before there are
 * real drivers online. Returns `[]` when disabled. Gated to dev/demo
 * builds by the caller — never shown to real users in production.
 */
export function useTestVehicles(
  center: { lat: number; lng: number } | null,
  enabled: boolean,
): NearbyVehicle[] {
  const [vehicles, setVehicles] = useState<TestVehicle[]>([]);

  useEffect(() => {
    if (!enabled || !center) {
      setVehicles([]);
      return;
    }
    setVehicles(generateTestVehicles(center, 8));
    const id = setInterval(() => {
      setVehicles((prev) => stepTestVehicles(prev, STEP_INTERVAL_MS / 1000, center));
    }, STEP_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, center?.lat, center?.lng]);

  return vehicles;
}
