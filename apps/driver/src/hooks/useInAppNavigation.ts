import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as Speech from 'expo-speech';
import {
  fetchNavigationRoute,
  haversineDistance,
  distanceToPolyline,
  type NavigationStep,
  type NavigationRouteResult,
  type GeoPoint,
} from '@tricigo/utils';

/**
 * BUG-278: voice-timing constants for two-tier turn-by-turn announcements.
 *
 *   PRE_ANNOUNCE_DISTANCE_M (200 m) — say "In 200 metros, gira a la
 *     derecha por Calle X". Only fires if the *current* step is at least
 *     this long; otherwise the previous turn just happened and announcing
 *     a new one would overlap. (User's "siempre cuando no haya otra
 *     intersección" rule.)
 *
 *   IMMINENT_ANNOUNCE_DISTANCE_M (50 m) — say "Gira a la derecha". Final
 *     confirmation right before the maneuver, always fires regardless of
 *     pre-announce state.
 *
 *   STEP_ADVANCE_THRESHOLD_M (20 m) — mark the step as completed and
 *     advance currentStepIndex. No voice fires here; voice was handled
 *     by the imminent announce a few seconds earlier. Lower than the
 *     previous 30 m to ensure the imminent announce fully plays before
 *     the next step's pre-announce starts.
 */
const PRE_ANNOUNCE_DISTANCE_M = 200;
const IMMINENT_ANNOUNCE_DISTANCE_M = 50;
const STEP_ADVANCE_THRESHOLD_M = 20;
/**
 * Re-route when driver deviates more than this distance from route.
 * BUG-298: lowered from 50 to 35m. Cuban urban driving has many parallel
 * streets 30-40m apart; the previous 50m threshold missed real deviations
 * onto a parallel street. Aligned with the client `DEVIATION_M = 35`.
 */
const REROUTE_THRESHOLD_M = 35;
/**
 * Minimum interval between re-route attempts.
 * BUG-298: lowered from 10_000 to 4_000ms. Previous value gave ~19s worst
 * case (1s detect + 10s cooldown + 8s fetch) between a deviation and a new
 * route being visible — too slow when the driver has already turned. Now
 * ~8s worst case, aligned with the client `MIN_INTERVAL_MS`.
 */
const REROUTE_COOLDOWN_MS = 4_000;

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
  /** Start navigating to a destination, optionally through pending stops */
  startNavigation: (destination: GeoPoint, waypoints?: GeoPoint[]) => Promise<void>;
  /** Re-thread the active route through a new set of pending stops (no restart) */
  updateNavWaypoints: (waypoints: GeoPoint[]) => Promise<void>;
  /** Stop navigation */
  stopNavigation: () => void;
}

/**
 * Hook for in-app turn-by-turn navigation.
 * Tracks driver's position against OSRM route steps and auto-advances.
 *
 * @param driverLocation Current driver GPS location.
 * @param voiceEnabled Whether to speak each step transition (defaults to true).
 */
export function useInAppNavigation(
  driverLocation: GeoPoint | null,
  voiceEnabled: boolean = true,
): UseInAppNavigationReturn {
  const [isNavigating, setIsNavigating] = useState(false);
  const [route, setRoute] = useState<NavigationRouteResult | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isRerouting, setIsRerouting] = useState(false);

  const destinationRef = useRef<GeoPoint | null>(null);
  // Pending passenger stops the active route threads through (driver → stops →
  // destination). navWpKeyRef dedupes re-fetches when the list is unchanged.
  const waypointsRef = useRef<GeoPoint[]>([]);
  const navWpKeyRef = useRef<string>('');
  const lastRerouteRef = useRef(0);
  /**
   * BUG-278: separate refs for the three announce phases per step so
   * each fires once and only once.
   *   - departAnnouncedRef: did we say "Inicia el recorrido por X" yet?
   *   - preAnnouncedStepRef: which upcoming step (currentStepIndex+1)
   *       did we already pre-announce (200m before)?
   *   - imminentAnnouncedStepRef: which upcoming step did we already
   *       imminent-announce (50m before)?
   */
  const departAnnouncedRef = useRef<boolean>(false);
  const preAnnouncedStepRef = useRef<number>(-1);
  const imminentAnnouncedStepRef = useRef<number>(-1);
  /** Keep voiceEnabled fresh without re-running the step-advance effect. */
  const voiceEnabledRef = useRef(voiceEnabled);
  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
    // If the driver toggles voice off mid-route, stop any in-flight utterance.
    if (!voiceEnabled) {
      Speech.stop().catch(() => {});
    }
  }, [voiceEnabled]);

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
      // Thread the current pending stops so both the initial fetch AND the
      // deviation re-route keep driver → stops → destination.
      waypointsRef.current.map((w) => ({ lat: w.latitude, lng: w.longitude })),
    );
  }, []);

  const startNavigation = useCallback(async (destination: GeoPoint, waypoints: GeoPoint[] = []) => {
    if (!driverLocation || isNavigating || isLoading) return;
    setIsLoading(true);
    destinationRef.current = destination;
    waypointsRef.current = waypoints;
    navWpKeyRef.current = waypoints.map((w) => `${w.latitude},${w.longitude}`).join('|');
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
  }, [driverLocation, isNavigating, isLoading, fetchRoute]);

  /**
   * Re-thread the ACTIVE navigation through a new set of pending stops (the
   * passenger added one, or the driver departed one) WITHOUT restarting nav.
   * Re-fetches driver → stops → destination from the current position. No-op
   * if the list is unchanged or navigation isn't running.
   */
  const updateNavWaypoints = useCallback(async (waypoints: GeoPoint[]) => {
    if (!isNavigating || !destinationRef.current || !driverLocation) return;
    const key = waypoints.map((w) => `${w.latitude},${w.longitude}`).join('|');
    if (key === navWpKeyRef.current) return;
    navWpKeyRef.current = key;
    waypointsRef.current = waypoints;
    setIsRerouting(true);
    try {
      const result = await fetchRoute(driverLocation, destinationRef.current);
      if (result && result.steps.length > 0) {
        setRoute(result);
        setCurrentStepIndex(0);
      }
    } finally {
      setIsRerouting(false);
    }
  }, [isNavigating, driverLocation, fetchRoute]);

  const stopNavigation = useCallback(() => {
    setIsNavigating(false);
    setRoute(null);
    setCurrentStepIndex(0);
    destinationRef.current = null;
    waypointsRef.current = [];
    navWpKeyRef.current = '';
    departAnnouncedRef.current = false;
    preAnnouncedStepRef.current = -1;
    imminentAnnouncedStepRef.current = -1;
    // Cancel any pending utterance when navigation ends.
    Speech.stop().catch(() => {});
  }, []);

  /**
   * BUG-278: Depart announcement on navigation start.
   * Fires once when the driver starts navigating (currentStepIndex=0).
   * The other transitions are handled inside the step-advance effect
   * below where we have access to the live distance to the next maneuver.
   */
  useEffect(() => {
    if (!isNavigating) {
      departAnnouncedRef.current = false;
      preAnnouncedStepRef.current = -1;
      imminentAnnouncedStepRef.current = -1;
      return;
    }
    if (!voiceEnabledRef.current) return;
    if (departAnnouncedRef.current) return;
    const step = steps[0];
    if (!step) return;

    departAnnouncedRef.current = true;
    const text = buildSpokenInstruction(step);
    if (!text) return;

    Speech.stop()
      .catch(() => {})
      .finally(() => {
        Speech.speak(text, { language: 'es-ES', rate: 1.0, pitch: 1.0 });
      });
  }, [isNavigating, steps]);

  // Cleanup: stop TTS if the hook unmounts mid-utterance.
  useEffect(() => {
    return () => {
      Speech.stop().catch(() => {});
    };
  }, []);

  /**
   * BUG-278: distance-aware voice + step advance.
   *
   * Three triggers per step transition:
   *   1. PRE-ANNOUNCE at 200 m before step[i+1].maneuver_location:
   *      "En 200 metros, gira a la derecha por Calle X". Skipped if
   *      step[i].distance_m < PRE_ANNOUNCE_DISTANCE_M (the previous
   *      maneuver was less than 200 m back, so a pre-announce would
   *      stack on top of the previous imminent).
   *   2. IMMINENT at 50 m: "Gira a la derecha". Always fires.
   *   3. ADVANCE at 20 m: increment currentStepIndex silently. The
   *      voice has already played, the visual overlay updates to show
   *      the next instruction.
   *
   * We compute the distance to the NEXT step's maneuver every render
   * (cheap haversine) and gate each trigger by an idempotency ref so
   * the same step never speaks twice.
   */
  useEffect(() => {
    if (!isNavigating || !driverLocation || !route || steps.length === 0) return;

    // Mid-route: pre-announce + imminent + advance to next step
    if (currentStepIndex < steps.length - 1) {
      const nextStep = steps[currentStepIndex + 1];
      const nextStepManeuver = nextStep?.maneuver_location;
      if (nextStep && nextStepManeuver) {
        const distToNext = haversineDistance(driverLocation, {
          latitude: nextStepManeuver[0],
          longitude: nextStepManeuver[1],
        });
        const targetIdx = currentStepIndex + 1;

        // Pre-announce — only if there's enough room before the turn
        const currentStepLen = steps[currentStepIndex]?.distance_m ?? 0;
        if (
          voiceEnabledRef.current &&
          preAnnouncedStepRef.current !== targetIdx &&
          distToNext <= PRE_ANNOUNCE_DISTANCE_M &&
          distToNext > IMMINENT_ANNOUNCE_DISTANCE_M &&
          currentStepLen >= PRE_ANNOUNCE_DISTANCE_M
        ) {
          preAnnouncedStepRef.current = targetIdx;
          const text = buildSpokenInstructionWithDistance(nextStep, Math.round(distToNext));
          Speech.stop()
            .catch(() => {})
            .finally(() => {
              Speech.speak(text, { language: 'es-ES', rate: 1.0, pitch: 1.0 });
            });
        }

        // Imminent — always fires at 50 m
        if (
          voiceEnabledRef.current &&
          imminentAnnouncedStepRef.current !== targetIdx &&
          distToNext <= IMMINENT_ANNOUNCE_DISTANCE_M
        ) {
          imminentAnnouncedStepRef.current = targetIdx;
          const text = buildSpokenInstruction(nextStep);
          Speech.stop()
            .catch(() => {})
            .finally(() => {
              Speech.speak(text, { language: 'es-ES', rate: 1.0, pitch: 1.0 });
            });
        }

        // Advance step
        if (distToNext < STEP_ADVANCE_THRESHOLD_M) {
          setCurrentStepIndex((prev) => prev + 1);
          return;
        }
      }
    }

    // Last step → arrival
    if (currentStepIndex === steps.length - 1) {
      const lastStep = steps[steps.length - 1]!;
      const distToEnd = haversineDistance(driverLocation, {
        latitude: lastStep.maneuver_location[0]!,
        longitude: lastStep.maneuver_location[1]!,
      });
      if (distToEnd < STEP_ADVANCE_THRESHOLD_M) {
        if (voiceEnabledRef.current && imminentAnnouncedStepRef.current !== currentStepIndex) {
          imminentAnnouncedStepRef.current = currentStepIndex;
          Speech.stop()
            .catch(() => {})
            .finally(() => {
              Speech.speak('Llegaste a tu destino', { language: 'es-ES', rate: 1.0, pitch: 1.0 });
            });
        }
        stopNavigation();
        return;
      }
    }

    // Check if driver deviated from route — trigger reroute.
    //
    // BUG-298: measure perpendicular distance to the FULL route polyline
    // (not vertex-distance to the current step's geometry).
    //
    // Old behavior: iterated `currentStep.geometry` vertices and used
    // `haversineDistance(driver, vertex)`. Two problems:
    //   1. Vertex-distance overestimates when step segments are long: a
    //      driver 100m perpendicular to a 200m segment can be 141m from
    //      the nearest vertex → false positive (rerouting when on-route).
    //   2. If the driver cuts a corner past the current step, the current
    //      step's geometry stays behind them, so the deviation against
    //      the OLD step keeps growing without considering segments ahead.
    //
    // New behavior: use `distanceToPolyline` against `route.coordinates`
    // (full route), matching what the client RideMapView already does in
    // `useDriverToPickupRoute.ts` (BUG-279).
    const routeCoords = route?.coordinates;
    if (routeCoords && routeCoords.length >= 2) {
      const routePolyline: GeoPoint[] = routeCoords.map(
        (pair: [number, number]) => ({ latitude: pair[0], longitude: pair[1] }),
      );
      const minDistToRoute = distanceToPolyline(driverLocation, routePolyline);

      const now = Date.now();
      if (
        minDistToRoute > REROUTE_THRESHOLD_M &&
        now - lastRerouteRef.current > REROUTE_COOLDOWN_MS &&
        destinationRef.current &&
        !isRerouting
      ) {
        lastRerouteRef.current = now;
        setIsRerouting(true);
        // eslint-disable-next-line no-console
        console.log('[useInAppNavigation] reroute', {
          off_m: Math.round(minDistToRoute),
          threshold_m: REROUTE_THRESHOLD_M,
          since_last_ms: now - (lastRerouteRef.current - REROUTE_COOLDOWN_MS),
        });
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
    updateNavWaypoints,
    stopNavigation,
  };
}

/**
 * BUG-278: pre-announce variant — speak the maneuver with a distance
 * prefix ("En 200 metros, gira a la derecha por Calle X"). Used when
 * the driver is approaching but not yet at the turn. The plain
 * `buildSpokenInstruction` is reserved for the imminent (50 m) call.
 */
export function buildSpokenInstructionWithDistance(
  step: NavigationStep,
  distance_m: number,
): string {
  const { maneuver_type, maneuver_modifier, name } = step;
  const street = name?.trim();
  const distText = `En ${distance_m} metros`;

  if (maneuver_type === 'arrive') {
    return step.waypoint_index != null
      ? `${distText} llegarás a la Parada ${step.waypoint_index + 1}`
      : `${distText} llegarás a tu destino`;
  }

  const direction = (() => {
    switch (maneuver_modifier) {
      case 'left': return 'gira a la izquierda';
      case 'sharp left': return 'gira cerrado a la izquierda';
      case 'slight left': return 'gira ligeramente a la izquierda';
      case 'right': return 'gira a la derecha';
      case 'sharp right': return 'gira cerrado a la derecha';
      case 'slight right': return 'gira ligeramente a la derecha';
      case 'uturn': return 'haz un giro en U';
      case 'straight':
      default: return 'continúa recto';
    }
  })();

  return street ? `${distText}, ${direction} por ${street}` : `${distText}, ${direction}`;
}

/**
 * Build a plain-Spanish sentence for text-to-speech from a NavigationStep.
 * Independent of i18n so the TTS effect can stay decoupled from React
 * translation contexts. Cuban market is Spanish-first, so we hardcode ES.
 */
export function buildSpokenInstruction(step: NavigationStep): string {
  const { maneuver_type, maneuver_modifier, name } = step;
  const street = name?.trim();

  if (maneuver_type === 'arrive') {
    return step.waypoint_index != null
      ? `Llegaste a la Parada ${step.waypoint_index + 1}`
      : 'Llegaste a tu destino';
  }
  if (maneuver_type === 'depart') {
    return street ? `Dirígete por ${street}` : 'Inicia el recorrido';
  }

  const direction = (() => {
    switch (maneuver_modifier) {
      case 'left': return 'Gira a la izquierda';
      case 'sharp left': return 'Gira cerrado a la izquierda';
      case 'slight left': return 'Gira ligeramente a la izquierda';
      case 'right': return 'Gira a la derecha';
      case 'sharp right': return 'Gira cerrado a la derecha';
      case 'slight right': return 'Gira ligeramente a la derecha';
      case 'uturn': return 'Haz un giro en U';
      case 'straight':
      default: return 'Continúa recto';
    }
  })();

  return street ? `${direction} por ${street}` : direction;
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
