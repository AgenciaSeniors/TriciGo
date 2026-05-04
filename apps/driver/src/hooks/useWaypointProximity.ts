/**
 * useWaypointProximity — extracted from DriverTripView for PR-A.
 *
 * DE-2.1: auto-detects waypoint arrival by GPS proximity during
 * in_progress.
 *   - dist < 100m → set `nearWaypoint = true` (parent shows banner)
 *   - dist < 50m  → schedule auto-arrive in 8s (cancellable if driver
 *     drives away). Emits a `driver_waypoint_auto_arrived` validation
 *     event.
 *
 * The auto-arrive trigger calls `onAutoArrive(waypoint)` which the
 * parent wires to its own `handleArriveAtWaypoint` (so the existing
 * Toast + service call + state update flow is preserved verbatim).
 *
 * Behavior preserved from inline version.
 */
import { useEffect, useState } from 'react';
import Toast from 'react-native-toast-message';
import { trackValidationEvent } from '@tricigo/api';
import { haversineDistance } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';

interface UseWaypointProximityArgs {
  rideId: string | null | undefined;
  status: string | null | undefined;
  nextWaypoint: {
    id: string;
    sort_order: number;
    latitude: number;
    longitude: number;
  } | null;
  driverLocation: { latitude: number; longitude: number } | null;
  onAutoArrive: () => void;
}

interface UseWaypointProximityResult {
  nearWaypoint: boolean;
}

export function useWaypointProximity({
  rideId,
  status,
  nextWaypoint,
  driverLocation,
  onAutoArrive,
}: UseWaypointProximityArgs): UseWaypointProximityResult {
  const { t } = useTranslation('driver');
  const [nearWaypoint, setNearWaypoint] = useState(false);

  useEffect(() => {
    if (status !== 'in_progress' || !nextWaypoint || !driverLocation) {
      setNearWaypoint(false);
      return;
    }

    const dist = haversineDistance(
      driverLocation,
      { latitude: nextWaypoint.latitude, longitude: nextWaypoint.longitude },
    );

    if (dist < 100) {
      setNearWaypoint(true);
    } else {
      setNearWaypoint(false);
    }

    if (dist < 50) {
      Toast.show({
        type: 'info',
        text1: t('trip.auto_arriving', { defaultValue: 'Marcando llegada automáticamente...' }),
        visibilityTime: 3000,
      });
      const timeout = setTimeout(() => {
        if (rideId) {
          trackValidationEvent('driver_waypoint_auto_arrived', {
            waypoint_sort_order: nextWaypoint.sort_order,
            gps_distance_m: Math.round(dist),
          }, rideId);
        }
        onAutoArrive();
      }, 8000);
      return () => clearTimeout(timeout);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverLocation?.latitude, driverLocation?.longitude, nextWaypoint?.id, status]);

  return { nearWaypoint };
}
