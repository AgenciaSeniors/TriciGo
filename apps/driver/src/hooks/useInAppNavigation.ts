import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  fetchNavigationRoute,
  haversineDistance,
  type NavigationStep,
  type NavigationRouteResult,
  type GeoPoint,
} from '@tricigo/utils';

/** Minimum distance (meters) to advance to the next step */
const STEP_ADVANCE_THRESHOLD_M = 30;
/** Re-route when driver deviates more than this distance from route */
const REROUTE_THRESHOLD_M = 50;
/** Minimum interval between re-route attempts */
const REROUTE_COOLDOWN_MS = 10_000;

export interface InAppNavState {
  /** Whether navigation is active */
  isNavigating: boolean;
  /** All navigation steps */
  steps: NavigationStep[];
  /** Index of the current step */
  currentStepIndex: number;
  /** Current step object */
  currentStep: NavigationStep | null;
  /** Next step object */
  nextStep: NavigationStep | null;
  /** Remaining distance to destination in meters */
  remainingDistance_m: number;
  /** Remaining duration in seconds */
  remainingDuration_s: number;
  /** Full route coordinates for map rendering */
  routeCoordinates: [number, number][];
  /** Whether route is loading */
  isLoading: boolean;
  /** Whether re-routing is in progress */
  isRerouting: boolean;
}

export interface UseInAppNavigationReturn extends InAppNavState {
  /** Start navigating to a destination */
  startNavigation: (destination: GeoPoint) => Promise<void>;
  /** Stop navigation */
  stopNavigation: () => void;
}

/**
 * Hook for in-app turn-by-turn navigation.
 * Tracks driver's position against OSRM route steps and auto-advances.
 */
export function useInAppNavigation(
  driverLocation: GeoPoint | null,
): UseInAppNavigationReturn {
  const [isNavigating, setIsNavigating] = useState(false);
  const [route, setRoute] = useState<NavigationRouteResult | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isRerouting, setIsRerouting] = useState(false);

  const destinationRef = useRef<GeoPoint | null>(null);
  const lastRerouteRef = useRef(0);

  const steps = route?.steps ?? [];
  const currentStep = steps[currentStepIndex] ?? null;
  const nextStep = steps[currentStepIndex + 1] ?? null;

  // Calculate remaining distance/duration from current step onward
  const { remainingDistance_m, remainingDuration_s } = useMemo(() => {
    if (!route || steps.length === 0) {
      return { remainingDistance_m: 0, remainingDuration_s: 0 };
    }
    let dist = 0;
    let dur = 0;
    for (let i = currentStepIndex; i < steps.length; i++) {
      const step = steps[i];
      if (step) {
        dist += step.distance_m;
        dur += step.duration_s;
      }
    }
    return { remainingDistance_m: Math.round(dist), remainingDuration_s: Math.round(dur) };
  }, [route, steps, currentStepIndex]);

  const routeCoordinates = route?.coordinates ?? [];

  // Fetch route from current driver position to destination
  const fetchRoute = useCallback(async (from: GeoPoint, to: GeoPoint): Promise<NavigationRouteResult | null> => {
    return fetchNavigationRoute(
      { lat: from.latitude, lng: from.longitude },
      { lat: to.latitude, lng: to.longitude },
    );
  }, []);

  const startNavigation = useCallback(async (destination: GeoPoint) => {
    if (!driverLocation) return;
    setIsLoading(true);
    destinationRef.current = destination;
    try {
      const result = await fetchRoute(driverLocation, destination);
      if (result && result.steps.length > 0) {
        setRoute(result);
        setCurrentStepIndex(0);
        setIsNavigating(true);
      }
    } finally {
      setIsLoading(false);
    }
  }, [driverLocation, fetchRoute]);

  const stopNavigation = useCallback(() => {
    setIsNavigating(false);
    setRoute(null);
    setCurrentStepIndex(0);
    destinationRef.current = null;
  }, []);

  // Auto-advance steps based on driver location
  useEffect(() => {
    if (!isNavigating || !driverLocation || !route || steps.length === 0) return;

    // Check if we should advance to next step
    if (currentStepIndex < steps.length - 1) {
      const nextStepManeuver = steps[currentStepIndex + 1]?.maneuver_location;
      if (nextStepManeuver) {
        const distToNext = haversineDistance(driverLocation, {
          latitude: nextStepManeuver[0],
          longitude: nextStepManeuver[1],
        });
        if (distToNext < STEP_ADVANCE_THRESHOLD_M) {
          setCurrentStepIndex((prev) => prev + 1);
          return;
        }
      }
    }

    // Check if arrived at destination (last step)
    if (currentStepIndex === steps.length - 1) {
      const lastStep = steps[steps.length - 1]!;
      const distToEnd = haversineDistance(driverLocation, {
        latitude: lastStep.maneuver_location[0]!,
        longitude: lastStep.maneuver_location[1]!,
      });
      if (distToEnd < STEP_ADVANCE_THRESHOLD_M) {
        stopNavigation();
        return;
      }
    }

    // Check if driver deviated from route — trigger reroute
    const currentStepGeom = currentStep?.geometry;
    if (currentStepGeom && currentStepGeom.length > 0) {
      let minDistToRoute = Infinity;
      for (const coord of currentStepGeom) {
        const d = haversineDistance(driverLocation, {
          latitude: coord[0],
          longitude: coord[1],
        });
        if (d < minDistToRoute) minDistToRoute = d;
      }

      const now = Date.now();
      if (
        minDistToRoute > REROUTE_THRESHOLD_M &&
        now - lastRerouteRef.current > REROUTE_COOLDOWN_MS &&
        destinationRef.current &&
        !isRerouting
      ) {
        lastRerouteRef.current = now;
        setIsRerouting(true);
        fetchRoute(driverLocation, destinationRef.current)
          .then((newRoute) => {
            if (newRoute && newRoute.steps.length > 0) {
              setRoute(newRoute);
              setCurrentStepIndex(0);
            }
          })
          .finally(() => setIsRerouting(false));
      }
    }
  }, [driverLocation, isNavigating, route, steps, currentStepIndex, currentStep, fetchRoute, stopNavigation, isRerouting]);

  return {
    isNavigating,
    steps,
    currentStepIndex,
    currentStep,
    nextStep,
    remainingDistance_m,
    remainingDuration_s,
    routeCoordinates,
    isLoading,
    isRerouting,
    startNavigation,
    stopNavigation,
  };
}

/**
 * Convert OSRM maneuver type/modifier to Ionicons icon name.
 */
export function getManeuverIcon(type: string, modifier: string): string {
  if (type === 'arrive') return 'flag';
  if (type === 'depart') return 'navigate';

  switch (modifier) {
    case 'left':
    case 'sharp left':
    case 'slight left':
      return 'arrow-back';
    case 'right':
    case 'sharp right':
    case 'slight right':
      return 'arrow-forward';
    case 'uturn':
      return 'return-down-back';
    case 'straight':
    default:
      return 'arrow-up';
  }
}

/**
 * Get a human-readable label for a maneuver.
 */
export function getManeuverLabel(
  type: string,
  modifier: string,
  streetName: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (type === 'arrive') {
    return t('nav.arrive', { defaultValue: 'Llegaste a tu destino' });
  }
  if (type === 'depart') {
    return streetName
      ? t('nav.depart_on', { street: streetName, defaultValue: `Dirígete por ${streetName}` })
      : t('nav.depart', { defaultValue: 'Inicia el recorrido' });
  }

  const direction = (() => {
    switch (modifier) {
      case 'left': return t('nav.turn_left', { defaultValue: 'Gira a la izquierda' });
      case 'sharp left': return t('nav.sharp_left', { defaultValue: 'Gira cerrado a la izquierda' });
      case 'slight left': return t('nav.slight_left', { defaultValue: 'Gira ligeramente a la izquierda' });
      case 'right': return t('nav.turn_right', { defaultValue: 'Gira a la derecha' });
      case 'sharp right': return t('nav.sharp_right', { defaultValue: 'Gira cerrado a la derecha' });
      case 'slight right': return t('nav.slight_right', { defaultValue: 'Gira ligeramente a la derecha' });
      case 'uturn': return t('nav.uturn', { defaultValue: 'Haz un giro en U' });
      case 'straight':
      default: return t('nav.continue', { defaultValue: 'Continúa recto' });
    }
  })();

  return streetName
    ? `${direction} ${t('nav.onto', { defaultValue: 'por' })} ${streetName}`
    : direction;
}
