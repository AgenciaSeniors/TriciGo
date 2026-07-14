import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Pressable,
  FlatList,
  Image,
  Animated,
  Dimensions,
  StyleSheet,
  Platform,
  Text as RNText,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from '@tricigo/i18n';
import { driverService, getSupabaseClient, walletService, useFeatureFlag, notificationService, trackValidationEvent } from '@tricigo/api';
import {
  HAVANA_CENTER,
  trackEvent,
  haversineDistance,
  logger,
  getErrorMessage,
  triggerHaptic,
  havanaMidnightUtc,
} from '@tricigo/utils';
import { openNavigation } from '@/utils/navigation';
import { useLocationStore } from '@/stores/location.store';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';
import { useNotificationStore } from '@/stores/notification.store';
import { useDriverRideStore } from '@/stores/ride.store';
import {
  useDriverRideInit,
  useIncomingRequests,
  useDriverRideActions,
} from '@/hooks/useDriverRide';
import { IncomingRideCard } from '@/components/IncomingRideCard';
import { DriverTripView, useActiveTripMapData } from '@/components/DriverTripView';
import { HomeBottomSheet } from '@/components/HomeBottomSheet';
import { useDriverLocationTracking } from '@/hooks/useDriverLocation';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import * as Location from 'expo-location';
import { LinearGradient } from 'expo-linear-gradient';
import { useDemandHotspots } from '@/hooks/useDemandHotspots';
import { usePopularLocations } from '@/hooks/usePopularLocations';
import { useNearbyDrivers } from '@/hooks/useNearbyDrivers';
import { useTestVehicles } from '@/hooks/useTestVehicles';
import { useSmartSuggestion } from '@/hooks/useSmartSuggestion';
import { useSelfieCheck } from '@/hooks/useSelfieCheck';
import { RideMapView } from '@/components/RideMapView';
import type { RideMapViewRef } from '@/components/RideMapView';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@tricigo/theme';
import type { Ride } from '@tricigo/types';
import { SubmitPoiSheet } from '@tricigo/ui';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

type OwnVehicleType = 'auto' | 'moto' | 'triciclo' | 'confort';

// Map a raw vehicles.type string to the marker slug. Module-scoped so it can be
// reused by the cache-hydration and the network-refetch paths without changing
// identity.
function mapOwnVehicleType(raw?: string | null): OwnVehicleType | undefined {
  if (!raw) return undefined;
  const t = String(raw).toLowerCase();
  if (t.startsWith('auto_confort') || t === 'confort') return 'confort';
  if (t.startsWith('auto')) return 'auto';
  if (t.startsWith('moto')) return 'moto';
  if (t.startsWith('triciclo')) return 'triciclo';
  return undefined;
}

// Per-driver cache of the resolved vehicle marker type. The type only comes
// from a network fetch (getVehicle); caching it makes the correct marker show
// instantly on next launch and — crucially — offline, instead of falling back
// to the neutral dot whenever that one fetch fails on a flaky network.
const OWN_VEHICLE_TYPE_CACHE_KEY = (driverId: string) => `driver_own_vehicle_type_v1:${driverId}`;

// BUG-218: dedicated wrapper for the active-trip map render.
// `useActiveTripMapData()` is a hook (calls `useDriverRideStore`,
// `useRoutePolyline`, etc.) so it must live at component top level.
// Splitting it into a separate component keeps the parent screen
// from running these hooks during the idle/online phase.
function ActiveTripMap({
  mapRef,
  driverLocation,
  onRecenter,
  screenHeight,
  followMode,
  onUserInteraction,
}: {
  mapRef: React.RefObject<RideMapViewRef | null>;
  driverLocation: { latitude: number; longitude: number } | null;
  onRecenter: () => void;
  screenHeight: number;
  followMode: boolean;
  onUserInteraction: () => void;
}) {
  const { pickupLocation, dropoffLocation, riderLocation, routeCoordinates, waypointLocations, waypointStatuses } = useActiveTripMapData();
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const rideStatus = activeTrip?.status ?? null;
  // BUG-258: driver marker wasn't rotating during turns because this
  // component never passed `driverHeading` to <RideMapView>. The store
  // already has the latest heading from useDriverLocation; we just need
  // to read it and forward it. Without this, RideMapView line 991 was
  // always rotating to 0deg (the `??` fallback).
  const driverHeading = useLocationStore((s) => s.heading);
  // BUG-218 (b): vehicleType for driver marker derived from ride.service_type.
  // The previous hardcoded "triciclo" was wrong for drivers with auto/moto/confort.
  const vehicleType = useMemo(() => {
    const slug = activeTrip?.service_type ?? '';
    if (slug.startsWith('auto_confort')) return 'confort';
    if (slug.startsWith('auto_')) return 'auto';
    if (slug.startsWith('moto_')) return 'moto';
    if (slug.startsWith('triciclo_')) return 'triciclo';
    // BUG-vehicle-type-mismatch: an unknown/empty service_type must NOT
    // silently render the driver as a car. Return undefined so the map
    // draws a neutral marker instead of defaulting to the almendrón.
    return undefined;
  }, [activeTrip?.service_type]);
  return (
    <RideMapView
      ref={mapRef}
      driverLocation={driverLocation}
      driverHeading={driverHeading}
      pickupLocation={pickupLocation}
      dropoffLocation={dropoffLocation}
      riderLocation={riderLocation}
      routeCoordinates={routeCoordinates}
      waypointLocations={waypointLocations}
      waypointStatuses={waypointStatuses}
      height={screenHeight}
      darkStyle
      onRecenter={onRecenter}
      vehicleType={vehicleType}
      followMode={followMode}
      onUserInteraction={onUserInteraction}
      // BUG-267 v3 — drive the per-status cinematic camera profile
      // (zoom/pitch tailored to accepted → in_progress).
      rideStatus={rideStatus}
    />
  );
}

// ─── Home screen ─────────────────────────────────────────────────────────────
function NativeDriverHomeScreen() {
  const { t } = useTranslation('driver');
  const insets = useSafeAreaInsets();
  const { profile, isOnline, setOnline } = useDriverStore();
  const user = useAuthStore((s) => s.user);
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const incomingRequests = useDriverRideStore((s) => s.incomingRequests);
  const removeRequest = useDriverRideStore((s) => s.removeRequest);
  const [toggling, setToggling] = useState(false);
  const [isIneligible, setIsIneligible] = useState(false);
  const [isOnBreak, setIsOnBreak] = useState(false);
  const [togglingBreak, setTogglingBreak] = useState(false);
  const notifCenterEnabled = useFeatureFlag('notification_center_enabled');
  const setUnreadCount = useNotificationStore((s) => s.setUnreadCount);
  const incrementUnread = useNotificationStore((s) => s.incrementUnread);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const [serviceConfigs, setServiceConfigs] = useState<Record<string, { base_fare_cup: number; per_km_rate_cup: number; per_minute_rate_cup: number; min_fare_cup: number }>>({});

  // HF-1: Heartbeat failure counter
  const heartbeatFailCountRef = useRef(0);

  // OMEGA: Auto-navigation countdown to hot zone
  const [navCountdown, setNavCountdown] = useState<number | null>(null);
  const navCancelledRef = useRef(false);

  // OMEGA: Online time tracking for earnings per hour
  const [onlineSince, setOnlineSince] = useState<number | null>(null);

  // DE-2.3: Idle time tracking for demand nudge
  const [idleSince, setIdleSince] = useState<number | null>(null);
  const [idleMinutes, setIdleMinutes] = useState(0);
  const [nearestHotZone, setNearestHotZone] = useState<{ lat: number; lng: number; distance: number } | null>(null);

  // DE-1.2: Preferred navigation memory (default: in-app map)
  const [preferredNav, setPreferredNav] = useState<'inapp' | 'external'>('inapp');

  useEffect(() => {
    AsyncStorage.getItem('preferred_nav').then((val) => {
      if (val === 'inapp' || val === 'external') setPreferredNav(val);
    }).catch(() => {});
  }, []);

  // BUG-216: One-time migration — clear stale 'external' default from earlier installs
  useEffect(() => {
    AsyncStorage.getItem('preferred_nav_migrated_v2').then((flag) => {
      if (flag !== '1') {
        AsyncStorage.setItem('preferred_nav', 'inapp').catch(() => {});
        AsyncStorage.setItem('preferred_nav_migrated_v2', '1').catch(() => {});
        setPreferredNav('inapp');
      }
    }).catch(() => {});
  }, []);

  // DT-2: Today's earnings state
  const [todayEarnings, setTodayEarnings] = useState({ amount: 0, trips: 0 });
  // V2: Yesterday's earnings — fed into HomeBottomSheet for storytelling
  // ("Ayer ganaste $X · N viajes" + "+18% vs ayer" comparison).
  const [yesterdayEarnings, setYesterdayEarnings] = useState<
    { amount: number; trips: number } | null
  >(null);

  // DT-2: Crossfade animation for trip transitions
  const tripFadeAnim = useRef(new Animated.Value(1)).current;
  const prevHadTrip = useRef(!!activeTrip);

  // ── HomeBottomSheet animations ──
  // V2: ring1/2/3, radarSweep and searchPulse refs were dropped together with
  // the "Ignition Portal" CTA, the radar sweep gradient, and the address-bar
  // pulse. The new HomeBottomSheet only needs ctaScaleAnim for press feedback.
  const ctaScaleAnim = useRef(new Animated.Value(1)).current;

  // Map ref for imperative camera control
  const mapRef = useRef<RideMapViewRef>(null);

  // BUG-218: own vehicle type for the IDLE map marker (was hardcoded
  // "triciclo"). Maps DriverProfile vehicle.type → marker icon slug.
  // BUG-vehicle-type-mismatch: default is `undefined` (unknown), NOT 'auto'.
  // Drivers whose vehicle isn't registered/verified yet (getVehicle → null)
  // were being drawn as a car; now they get a neutral marker until the real
  // type resolves.
  const [ownVehicleType, setOwnVehicleType] = useState<OwnVehicleType | undefined>(undefined);

  // Refetch the vehicle type from the network and persist it. Stable identity
  // (keyed on profile.id) so it can be wired to focus/foreground retries.
  const refetchOwnVehicleType = useCallback(() => {
    const id = profile?.id;
    if (!id) return;
    driverService.getVehicle(id).then((vehicle) => {
      const mapped = mapOwnVehicleType(vehicle?.type);
      if (mapped) {
        setOwnVehicleType(mapped);
        AsyncStorage.setItem(OWN_VEHICLE_TYPE_CACHE_KEY(id), mapped).catch(() => {});
      }
      // On null/unknown we keep the last known value (cache) rather than
      // downgrading to the neutral marker on a transient empty read.
    }).catch(() => { /* offline/transient → keep cached value, retry on focus */ });
  }, [profile?.id]);

  // BUG (driver-map): the vehicle type was fetched once with no retry and no
  // cache. If that single request failed on a flaky network, `ownVehicleType`
  // stayed undefined and the marker fell back to the neutral blue dot for the
  // WHOLE session (it never recovered — the effect only re-ran on profile.id).
  // That's why the triciclo icon showed "sometimes": it depended purely on
  // whether that one fetch happened to succeed at launch. Fix: hydrate from a
  // per-driver cache immediately (instant + offline), then refresh.
  useEffect(() => {
    const id = profile?.id;
    if (!id) return;
    let cancelled = false;
    AsyncStorage.getItem(OWN_VEHICLE_TYPE_CACHE_KEY(id)).then((cached) => {
      const mapped = mapOwnVehicleType(cached);
      // `prev ?? mapped` so a fresh network result already set never gets
      // clobbered by the slower cache read.
      if (!cancelled && mapped) setOwnVehicleType((prev) => prev ?? mapped);
    }).catch(() => {});
    refetchOwnVehicleType();
    return () => { cancelled = true; };
  }, [profile?.id, refetchOwnVehicleType]);

  // Retry when the app returns to the foreground / the Inicio tab regains focus,
  // so a fetch that failed while offline recovers without an app restart.
  useRefreshOnFocus(refetchOwnVehicleType);

  // Fetch service type configs once for fare calculation
  useEffect(() => {
    getSupabaseClient()
      .from('service_type_configs')
      .select('slug, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup')
      .eq('is_active', true)
      .then(({ data }) => {
        if (data) {
          const map: Record<string, { base_fare_cup: number; per_km_rate_cup: number; per_minute_rate_cup: number; min_fare_cup: number }> = {};
          for (const c of data) {
            map[c.slug] = { base_fare_cup: c.base_fare_cup, per_km_rate_cup: c.per_km_rate_cup, per_minute_rate_cup: c.per_minute_rate_cup, min_fare_cup: c.min_fare_cup };
          }
          setServiceConfigs(map);
        }
      });
  }, []);

  // Load initial break status from driver profile
  useEffect(() => {
    if (!profile) return;
    setIsOnBreak(!!(profile as any).is_on_break);
  }, [profile]);

  // HF-1: Heartbeat every 2 min while online
  useEffect(() => {
    if (!isOnline || !profile?.id) return;
    const sendHeartbeat = async () => {
      try {
        const supabase = getSupabaseClient();
        await supabase.from('driver_profiles')
          .update({ last_heartbeat_at: new Date().toISOString() })
          .eq('id', profile.id);
        heartbeatFailCountRef.current = 0;
        logger.info('[Heartbeat] Sent', { driver_id: profile.id });
      } catch (err) {
        heartbeatFailCountRef.current += 1;
        logger.warn('[Heartbeat] Failed', { driver_id: profile.id, error: getErrorMessage(err), consecutive_failures: heartbeatFailCountRef.current });
      }
    };
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 120_000);
    return () => clearInterval(interval);
  }, [isOnline, profile?.id]);

  // BUG-249: Fetch today's earnings + ride count from rides table.
  // Previous query against ledger_entries used columns that don't exist
  // (entry_type, user_id) and silently returned empty results — always 0.
  // Re-runs every 60s + whenever a trip ends so the home reflects the
  // most recent completion without manual reload.
  //
  // BUG-249v2 → extracted to `havanaMidnightUtc()` in @tricigo/utils.
  // Previously this useEffect inlined ~25 lines computing "midnight Havana,
  // today" with manual offset arithmetic + Intl.DateTimeFormat parsing.
  // The helper has the same robustness (handles DST + device TZ drift) but
  // with formatToParts + a UTC-noon probe (more explicit), full DST tests
  // in `packages/utils/src/__tests__/date.test.ts`, and is reusable in the
  // client app + admin.
  useEffect(() => {
    if (!profile?.id) return;
    const fetchEarnings = async () => {
      try {
        const supabase = getSupabaseClient();
        // Fix 4 (display conductor): live commission rate (was hardcoded 0.15)
        // so the HOY net matches the earnings screen / receipt when the
        // platform rate ≠ 15%. Default 0.15 on failure keeps the math identical
        // at 15% (mirrors IncomingRideCard / DriverTripView B4 pattern).
        let commissionRate = 0.15;
        try {
          const val = await walletService.getConfigValue('commission_rate');
          const parsed = parseFloat(String(val ?? '').replace(/"/g, ''));
          if (!isNaN(parsed) && parsed > 0 && parsed < 1) commissionRate = parsed;
        } catch { /* keep 0.15 */ }
        const sinceUtc = havanaMidnightUtc();
        const { data, error } = await supabase
          .from('rides')
          .select('final_fare_cup, completed_at')
          .eq('driver_id', profile.id)
          .eq('status', 'completed')
          .gte('completed_at', sinceUtc.toISOString());
        if (error) {
          console.warn('[home/earnings] query error', error.message);
          return;
        }
        const rows = data ?? [];
        const trips = rows.length;
        const gross = rows.reduce(
          (sum: number, r: { final_fare_cup: number | null }) => sum + (r.final_fare_cup ?? 0),
          0,
        );
        const amount = Math.round(gross * (1 - commissionRate));
        console.log('[home/earnings] fetched', {
          driver_id: profile.id,
          since_utc: sinceUtc.toISOString(),
          trips,
          gross,
          amount,
        });
        setTodayEarnings({ amount, trips });
      } catch (err) {
        console.warn('[home/earnings] exception', String(err));
      }
    };
    fetchEarnings();
    // Refresh every 60s; cheap and keeps the badge fresh.
    const interval = setInterval(fetchEarnings, 60_000);
    return () => clearInterval(interval);
  }, [profile?.id, activeTrip?.id]);

  // V2 — Fetch yesterday's earnings (Havana wall-clock day) so the
  // HomeBottomSheet can show "Ayer ganaste $X · N viajes" + the
  // "+18% vs ayer" comparison badge. Cached once per driver+day; we
  // re-fetch when profile or app comes back to foreground so the day
  // boundary re-computes after midnight.
  useEffect(() => {
    if (!profile?.id) return;
    const fetchYesterday = async () => {
      try {
        const supabase = getSupabaseClient();
        // Fix 4 (display conductor): live commission rate (was hardcoded 0.15);
        // keeps "Ayer" net consistent with HOY + the earnings screen.
        let commissionRate = 0.15;
        try {
          const val = await walletService.getConfigValue('commission_rate');
          const parsed = parseFloat(String(val ?? '').replace(/"/g, ''));
          if (!isNaN(parsed) && parsed > 0 && parsed < 1) commissionRate = parsed;
        } catch { /* keep 0.15 */ }
        const havanaOffsetHrs = (() => {
          const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Havana',
            timeZoneName: 'shortOffset',
          });
          const parts = fmt.formatToParts(new Date());
          const tzn = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5';
          const m = tzn.match(/GMT([+-]?\d+)/);
          return m && m[1] ? parseInt(m[1], 10) : -5;
        })();
        const nowUtcMs = Date.now();
        const havanaNowMs = nowUtcMs + havanaOffsetHrs * 3600_000;
        const havanaTodayMidnightWall = new Date(havanaNowMs);
        havanaTodayMidnightWall.setUTCHours(0, 0, 0, 0);
        const havanaYesterdayMidnightWall = new Date(havanaTodayMidnightWall.getTime() - 86_400_000);
        const yesterdayStartUtc = new Date(
          havanaYesterdayMidnightWall.getTime() - havanaOffsetHrs * 3600_000,
        );
        const todayStartUtc = new Date(
          havanaTodayMidnightWall.getTime() - havanaOffsetHrs * 3600_000,
        );
        const { data, error } = await supabase
          .from('rides')
          .select('final_fare_cup, completed_at')
          .eq('driver_id', profile.id)
          .eq('status', 'completed')
          .gte('completed_at', yesterdayStartUtc.toISOString())
          .lt('completed_at', todayStartUtc.toISOString());
        if (error) {
          console.warn('[home/earnings/yesterday] query error', error.message);
          return;
        }
        const rows = data ?? [];
        const trips = rows.length;
        const gross = rows.reduce(
          (sum: number, r: { final_fare_cup: number | null }) => sum + (r.final_fare_cup ?? 0),
          0,
        );
        const amount = Math.round(gross * (1 - commissionRate));
        setYesterdayEarnings({ amount, trips });
      } catch (err) {
        console.warn('[home/earnings/yesterday] exception', String(err));
      }
    };
    fetchYesterday();
    // Re-check every 30 min — the day boundary only matters around
    // midnight; this is mostly to handle the app being left open
    // overnight.
    const interval = setInterval(fetchYesterday, 30 * 60_000);
    return () => clearInterval(interval);
  }, [profile?.id]);

  // DT-2: Crossfade animation when activeTrip changes
  useEffect(() => {
    const hasTrip = !!activeTrip;
    if (hasTrip !== prevHadTrip.current) {
      prevHadTrip.current = hasTrip;
      Animated.timing(tripFadeAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => {
        Animated.timing(tripFadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
      });
    }
  }, [activeTrip, tripFadeAnim]);

  // V2: search pulse, ignition portal rings (3) and radar sweep effects
  // were removed together with the corresponding visuals in HomeBottomSheet.
  // The motion vocabulary is now closed by `midnightEmber.motion` and these
  // patterns are explicitly out-of-system (theatrical, anti-Linear).

  // ── HomeBottomSheet: CTA press spring ──
  const onCtaPressIn = useCallback(() => {
    Animated.spring(ctaScaleAnim, { toValue: 0.95, useNativeDriver: true, tension: 300, friction: 10 }).start();
  }, []);
  const onCtaPressOut = useCallback(() => {
    Animated.spring(ctaScaleAnim, { toValue: 1, useNativeDriver: true, tension: 300, friction: 10 }).start();
  }, []);

  // DE-1.2: Auto-launch preferred navigation when ride is accepted
  useEffect(() => {
    if (!activeTrip || activeTrip.status !== 'accepted') return;
    const target = activeTrip.pickup_location;
    if (!target) return;
    if (preferredNav === 'external') {
      openNavigation(target.latitude, target.longitude);
    }
  }, [activeTrip?.id, activeTrip?.status]);

  // Check financial eligibility
  useEffect(() => {
    if (!profile?.id) return;
    const checkEligibility = () => {
      driverService.getEligibilityStatus(profile.id).then((status) => {
        setIsIneligible(!status.is_eligible);
      }).catch((err) => console.warn('[Driver] Failed to check eligibility:', err));
    };
    checkEligibility();
    if (!isOnline) return;
    const interval = setInterval(checkEligibility, 60000);
    return () => clearInterval(interval);
  }, [profile?.id, isOnline]);

  // Fetch unread count + subscribe to realtime notifications
  useEffect(() => {
    if (!user?.id || !notifCenterEnabled) return;
    let cancelled = false;
    // BUG-080: Record fetch time to avoid counting notifications that arrived between fetch and subscribe
    const fetchTime = new Date().toISOString();
    (async () => {
      try {
        const count = await notificationService.getUnreadCount(user.id);
        if (!cancelled) setUnreadCount(count);
      } catch (err) { console.warn('[Notif] Failed to load unread count:', err); }
    })();
    const subscription = notificationService.subscribeToNotifications(user.id, (notification) => {
      if (!cancelled && (!notification?.created_at || notification.created_at > fetchTime)) {
        incrementUnread();
      }
    });
    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [user?.id, notifCenterEnabled]);

  // Init: check for active trip on mount
  useDriverRideInit();

  // Subscribe to incoming requests when online
  useIncomingRequests(isOnline && !activeTrip);

  // GPS tracking when online
  useDriverLocationTracking(profile?.id ?? null, isOnline, activeTrip?.id ?? null);

  // Selfie verification check
  const { needsCheck, isProcessing, loading: selfieLoading, submitSelfie, check: selfieCheck } = useSelfieCheck();

  const { acceptRide } = useDriverRideActions();

  // Driver's current GPS location
  const driverLat = useLocationStore((s) => s.latitude);
  const driverLng = useLocationStore((s) => s.longitude);
  // BUG-258: heading consumed by RideMapView idle render to rotate the
  // own-vehicle marker (so the driver sees their own car turning while
  // moving even when not in an active trip).
  const idleHeading = useLocationStore((s) => s.heading);

  const driverLocation = useMemo(
    () => (driverLat && driverLng ? { latitude: driverLat, longitude: driverLng } : null),
    [driverLat, driverLng],
  );

  // Auto-fly the camera to the first GPS fix. The <Camera /> defaultSettings
  // only applies on mount — if the map renders before location is available
  // (fallback demo/Havana center) and driverLocation later transitions from
  // null → coords, we need to explicitly move the camera.
  const hasFlownToInitialFixRef = useRef(false);
  useEffect(() => {
    if (!hasFlownToInitialFixRef.current && driverLocation) {
      hasFlownToInitialFixRef.current = true;
      mapRef.current?.flyTo(driverLocation.latitude, driverLocation.longitude, 15);
    }
  }, [driverLocation]);

  // Center for hotspot/peer lookups (stable reference so polling doesn't
  // thrash every render). Only updates when crossing ~300m.
  const mapCenter = useMemo(
    () => (driverLat && driverLng ? { lat: driverLat, lng: driverLng } : null),
    // Snap to ~300m grid (0.003°) to avoid re-polling on tiny GPS deltas.
    [
      driverLat ? Math.round(driverLat * 333) : null,
      driverLng ? Math.round(driverLng * 333) : null,
    ],
  );

  // Demand hotspots (replaces legacy demand heatmap).
  const demandHotspots = useDemandHotspots({
    center: mapCenter,
    enabled: isOnline,
  });

  // N5 — popular pickup/dropoff clusters (90-day historical aggregate).
  // Toggle gated; off by default to avoid overloading the map for
  // drivers who don't ask for it.
  const [popularLocationsEnabled, setPopularLocationsEnabled] = useState(false);
  const popularLocations = usePopularLocations({
    center: mapCenter,
    enabled: isOnline && popularLocationsEnabled,
  });

  // Phase 3 V4 — simple map mode. When enabled, suppresses the noisier
  // visual layers (surge polygons, demand-hotspot pulses, peer drivers,
  // top-of-screen alta-demanda/surge banners) so the map reduces to the
  // driver's own marker + active-trip context. Persisted in AsyncStorage
  // so it survives app reload — drivers who prefer the calm view get it
  // by default after the first toggle.
  const [simpleMapMode, setSimpleMapMode] = useState(false);
  // Crowdsourcing — "Sugerir lugar" sheet visibility + the coords the
  // driver was at when they tapped the button. We snapshot the location
  // so they can move the marker around during the form without losing it.
  const [submitPoiOpen, setSubmitPoiOpen] = useState(false);
  const [submitPoiCoords, setSubmitPoiCoords] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    AsyncStorage.getItem('driver_simple_map_mode').then((val) => {
      if (val === '1') setSimpleMapMode(true);
    }).catch(() => {});
  }, []);
  const toggleSimpleMapMode = useCallback(() => {
    setSimpleMapMode((prev) => {
      const next = !prev;
      AsyncStorage.setItem('driver_simple_map_mode', next ? '1' : '0').catch(() => {});
      trackValidationEvent('driver_map_density_toggled', { simple_mode: next });
      return next;
    });
  }, []);

  // Pre-launch QA: synthetic moving vehicles to preview marker rendering.
  // Gated to dev/demo builds — never shown to real drivers in production.
  const vehiclePreviewAvailable =
    __DEV__ || process.env.EXPO_PUBLIC_DEMO_MODE === 'true';
  const [vehiclePreview, setVehiclePreview] = useState(false);
  useEffect(() => {
    if (!vehiclePreviewAvailable) return;
    AsyncStorage.getItem('driver_vehicle_preview').then((val) => {
      if (val === '1') setVehiclePreview(true);
    }).catch(() => {});
  }, [vehiclePreviewAvailable]);
  const toggleVehiclePreview = useCallback(() => {
    setVehiclePreview((prev) => {
      const next = !prev;
      AsyncStorage.setItem('driver_vehicle_preview', next ? '1' : '0').catch(() => {});
      return next;
    });
  }, []);
  const previewVehicles = useTestVehicles(mapCenter, vehiclePreview);

  // Peer online drivers (top-down markers on the map).
  const nearbyDrivers = useNearbyDrivers({
    center: mapCenter,
    enabled: isOnline && !activeTrip,
    myDriverProfileId: profile?.id ?? null,
  });

  // DE-2.3: Track idle time and find nearest hot zone
  useEffect(() => {
    if (!isOnline || activeTrip || incomingRequests.length > 0 || isOnBreak) {
      setIdleSince(null);
      setIdleMinutes(0);
      setNearestHotZone(null);
      navCancelledRef.current = false;
      return;
    }
    if (!idleSince) setIdleSince(Date.now());
    const interval = setInterval(() => {
      if (idleSince) {
        const mins = Math.floor((Date.now() - idleSince) / 60000);
        setIdleMinutes(mins);
        if (mins >= 10 && demandHotspots.length > 0 && driverLat && driverLng) {
          const hotZones = demandHotspots
            .filter((p) => p.intensity > 0.7)
            .map((p) => ({
              lat: p.lat,
              lng: p.lng,
              distance: Math.round(haversineDistance(
                { latitude: driverLat, longitude: driverLng },
                { latitude: p.lat, longitude: p.lng },
              ) / 100) / 10,
            }))
            .sort((a, b) => a.distance - b.distance);
          if (hotZones.length > 0 && hotZones[0]) setNearestHotZone(hotZones[0]);
        }
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [isOnline, activeTrip, incomingRequests.length, isOnBreak, idleSince, demandHotspots, driverLat, driverLng]);

  // OMEGA: Trigger auto-nav countdown when idle >= 10 min
  useEffect(() => {
    if (idleMinutes >= 10 && nearestHotZone && navCountdown === null && !navCancelledRef.current) {
      setNavCountdown(10);
    }
  }, [idleMinutes, nearestHotZone]);

  // OMEGA: Auto-nav countdown timer
  useEffect(() => {
    if (navCountdown === null || navCountdown <= 0) return;
    const timer = setTimeout(() => {
      if (navCancelledRef.current) { setNavCountdown(null); return; }
      if (navCountdown === 1) {
        trackValidationEvent('driver_auto_nav_triggered', { zone_distance: nearestHotZone?.distance, idle_minutes: idleMinutes });
        openNavigation(nearestHotZone!.lat, nearestHotZone!.lng);
        setNavCountdown(null);
        setIdleSince(Date.now());
      } else {
        setNavCountdown(navCountdown - 1);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [navCountdown]);

  const cancelAutoNav = useCallback(() => {
    trackValidationEvent('driver_auto_nav_cancelled', { zone_distance: nearestHotZone?.distance, idle_minutes: idleMinutes });
    setNavCountdown(null);
    navCancelledRef.current = true;
  }, [nearestHotZone?.distance, idleMinutes]);

  // V2 — `estimatedWaitMinutes` was removed: the new HomeBottomSheet
  // replaces the passive "~5 min wait" line with an actionable
  // suggestion card (see `nearestHotspot` below).

  // Phase 2 N1 — Smart route suggestion for HomeBottomSheet. Composes the
  // live demand signals (live hotspots + popular pickup clusters) into a
  // single ranked target. Replaces the prior hotspots-only useMemo; the
  // `popular` source falls through into the bottom-sheet card so the driver
  // gets richer context ("Hotspot a 3 km · 6 viajes activos"). Returns null
  // when no candidate scores within range.
  const nearestHotspot = useSmartSuggestion({
    driverLocation,
    hotspots: demandHotspots,
    popularLocations,
  });

  // OMEGA: Online time tracking for earnings per hour.
  // N6 DB-backed (00261): prefer the DB session timestamp from
  // `get_active_work_session` so the fatigue counter is cross-device.
  // AsyncStorage `driver_online_since` stays as the fallback when the
  // RPC is missing (00261 not applied) or the open session predates
  // the migration. Order on online toggle:
  //   1. Try DB → use started_at if present
  //   2. Fallback: AsyncStorage cached value
  //   3. Last resort: Date.now() (just-now session start)
  useEffect(() => {
    if (isOnline && !onlineSince) {
      let cancelled = false;
      const resolve = async () => {
        // 1. DB-first
        if (profile?.id) {
          try {
            const session = await driverService.getActiveWorkSession(profile.id);
            if (!cancelled && session?.started_at) {
              const dbMs = new Date(session.started_at).getTime();
              if (!isNaN(dbMs) && dbMs > 0) {
                setOnlineSince(dbMs);
                AsyncStorage.setItem('driver_online_since', String(dbMs)).catch(() => {});
                return;
              }
            }
          } catch {
            /* swallow — fall through to AsyncStorage */
          }
        }
        // 2. AsyncStorage fallback
        try {
          const val = await AsyncStorage.getItem('driver_online_since');
          if (cancelled) return;
          if (val) {
            const parsed = parseInt(val, 10);
            if (!isNaN(parsed) && parsed > 0) {
              setOnlineSince(parsed);
              return;
            }
          }
        } catch {
          /* fall through */
        }
        // 3. Just-now
        if (!cancelled) setOnlineSince(Date.now());
      };
      resolve();
      return () => {
        cancelled = true;
      };
    } else if (isOnline && onlineSince) {
      AsyncStorage.setItem('driver_online_since', String(onlineSince)).catch(() => {});
    } else if (!isOnline) {
      setOnlineSince(null);
      AsyncStorage.removeItem('driver_online_since').catch(() => {});
    }
  }, [isOnline, profile?.id]);

  // Phase 2 N6 — anti-fatigue. `sessionHours` is state-backed so the
  // banner threshold transitions (none → soft at 6h, soft → firm at 10h)
  // re-render the screen even though `onlineSince` itself doesn't change
  // mid-session. Re-evaluated every minute, cleared when offline.
  const [sessionHours, setSessionHours] = useState(0);
  useEffect(() => {
    if (!onlineSince || !isOnline) {
      setSessionHours(0);
      return;
    }
    const update = () => {
      setSessionHours(Math.max((Date.now() - onlineSince) / 3600000, 0));
    };
    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [onlineSince, isOnline]);

  const fatigueLevel: 'none' | 'soft' | 'firm' =
    sessionHours >= 10 ? 'firm' : sessionHours >= 6 ? 'soft' : 'none';

  // Track first-show transitions per session so we can measure both
  // surfacing and follow-through (the break action wires straight to
  // `handleToggleBreak`, which already fires `driver_break_started`).
  const prevFatigueLevelRef = useRef<'none' | 'soft' | 'firm'>('none');
  useEffect(() => {
    if (fatigueLevel !== 'none' && fatigueLevel !== prevFatigueLevelRef.current) {
      trackValidationEvent('driver_fatigue_warning_shown', {
        level: fatigueLevel,
        session_hours: Math.round(sessionHours * 10) / 10,
      });
    }
    prevFatigueLevelRef.current = fatigueLevel;
  }, [fatigueLevel, sessionHours]);

  // ── Handlers ──────────────────────────────────────────────────────────────────
  const handleToggleOnline = useCallback(async () => {
    if (toggling) return;
    if (!profile) {
      Toast.show({ type: 'error', text1: t('common.error'), text2: t('common.status_change_failed', { defaultValue: 'No se pudo cambiar el estado' }) });
      logger.warn('[Toggle] No driver profile loaded');
      return;
    }
    if (!isOnline && Platform.OS !== 'web') {
      // On native, request location permission before going online
      let { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') {
        // Permission not granted yet — request it
        const res = await Location.requestForegroundPermissionsAsync();
        status = res.status;
      }
      if (status !== 'granted') {
        Toast.show({ type: 'error', text1: t('home.location_required') });
        logger.warn('[GPS] Permission denied, blocking online');
        return;
      }
    }
    if (isOnline && activeTrip) {
      Toast.show({ type: 'error', text1: t('driver.cannot_offline_active_ride', { defaultValue: 'No puedes desconectarte durante un viaje activo' }) });
      return;
    }
    setToggling(true);
    try {
      const newStatus = !isOnline;
      // Don't write a fallback location on toggle — the real GPS from
      // watchPositionAsync (in useDriverLocationTracking) is the single
      // source of truth for current_location. Writing a fallback here
      // would persist stale/wrong coords if GPS permission is denied or
      // the first fix is slow, making the driver discoverable at a
      // location they aren't actually at.
      await driverService.setOnlineStatus(profile.id, newStatus, undefined);
      setOnline(newStatus);
      trackEvent(newStatus ? 'driver_went_online' : 'driver_went_offline');
      // UX: positive confirmation closes the loop after the toggle. Without
      // this, the toggle button state is the only feedback — drivers on a
      // flaky connection frequently tap twice because they aren't sure the
      // server received the change. Haptic + toast reassures them.
      triggerHaptic(newStatus ? 'success' : 'light');
      Toast.show({
        type: 'success',
        text1: newStatus
          ? t('driver.now_online_title', { defaultValue: 'Estás en línea' })
          : t('driver.now_offline_title', { defaultValue: 'Estás desconectado' }),
        text2: newStatus
          ? t('driver.now_online_sub', { defaultValue: 'Recibirás ofertas de viaje cerca de ti.' })
          : t('driver.now_offline_sub', { defaultValue: 'No recibirás nuevas ofertas hasta que te conectes.' }),
        visibilityTime: 2200,
      });
    } catch (err) {
      const rawMsg = getErrorMessage(err);
      logger.error('[Toggle] Failed to set online status', { error: rawMsg });
      // 00491: friendly message when the driver has no registered vehicle
      // (service pre-check + DB trigger). Otherwise show the raw error.
      const friendly = /driver_has_no_active_vehicle/.test(rawMsg)
        ? t('driver.online_needs_vehicle', {
            defaultValue: 'Registra tu vehículo antes de conectarte.',
          })
        : rawMsg;
      Toast.show({
        type: 'error',
        text1: t('common.status_change_failed'),
        text2: friendly,
        visibilityTime: 5000,
      });
      triggerHaptic('error');
    } finally {
      setToggling(false);
    }
  }, [profile, isOnline, setOnline, activeTrip, t]);

  const handleToggleBreak = useCallback(async () => {
    if (!profile || togglingBreak) return;
    if (activeTrip && activeTrip.status !== 'completed' && activeTrip.status !== 'canceled') {
      Toast.show({ type: 'error', text1: t('driver.cannot_break_active_ride', { defaultValue: 'No puedes descansar durante un viaje activo' }) });
      return;
    }
    setTogglingBreak(true);
    try {
      const newBreakStatus = !isOnBreak;
      await driverService.setBreakStatus(profile.id, newBreakStatus);
      setIsOnBreak(newBreakStatus);
      trackEvent(newBreakStatus ? 'driver_break_started' : 'driver_break_ended');
    } catch (err) {
      logger.error('[Toggle] Failed to set break status', { error: getErrorMessage(err) });
      Toast.show({
        type: 'error',
        text1: t('common.status_change_failed'),
        text2: getErrorMessage(err),
        visibilityTime: 5000,
      });
    } finally {
      setTogglingBreak(false);
    }
  }, [profile, isOnBreak, togglingBreak, activeTrip]);

  const handleAccept = useCallback((rideId: string) => acceptRide(rideId), [acceptRide]);
  const handleReject = useCallback((rideId: string) => removeRequest(rideId), [removeRequest]);

  // Navigation mode (Uber-driver style): heading-up rotation, 3D tilt,
  // zoom-out lock, auto-center on driver. Re-engages every time a new
  // active trip starts. User pan/zoom flips it OFF temporarily; after
  // 8s of no further interaction it auto-resumes (so the driver doesn't
  // get stuck with a static map if they accidentally bump the screen).
  // The floating recenter button forces immediate re-engage.
  const [followMode, setFollowMode] = useState<boolean>(true);
  // BUG-291 v2: auto-resume timer reference. Without this, a single
  // false-positive map-interaction event (e.g. a programmatic Mapbox
  // animation that's mis-tagged as a user gesture) would freeze the
  // follow camera for the entire ride.
  const followResumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Engage navigation mode whenever a fresh activeTrip arrives
    // (accept, status transitions). Disengage when no active trip.
    setFollowMode(!!activeTrip);
    // New ride starts clean — kill any pending resume timer from a
    // previous ride.
    if (followResumeTimerRef.current) {
      clearTimeout(followResumeTimerRef.current);
      followResumeTimerRef.current = null;
    }
  }, [activeTrip?.id]);

  // Cleanup the resume timer on unmount.
  useEffect(() => {
    return () => {
      if (followResumeTimerRef.current) {
        clearTimeout(followResumeTimerRef.current);
        followResumeTimerRef.current = null;
      }
    };
  }, []);

  const handleUserMapInteraction = useCallback(() => {
    setFollowMode(false);
    if (followResumeTimerRef.current) clearTimeout(followResumeTimerRef.current);
    // Only auto-resume during an active trip — idle online sessions
    // expect manual follow toggle.
    followResumeTimerRef.current = setTimeout(() => {
      const stillInTrip = !!useDriverRideStore.getState().activeTrip;
      if (stillInTrip) setFollowMode(true);
    }, 8000);
  }, []);

  const handleRecenter = useCallback(() => {
    if (followResumeTimerRef.current) {
      clearTimeout(followResumeTimerRef.current);
      followResumeTimerRef.current = null;
    }
    if (driverLocation) {
      mapRef.current?.flyTo(driverLocation.latitude, driverLocation.longitude, 15);
    }
    // Re-engage navigation mode so the camera follows + rotates again.
    setFollowMode(true);
  }, [driverLocation]);

  const handleAddressSelect = useCallback(({ latitude, longitude }: { latitude: number; longitude: number; address: string }) => {
    mapRef.current?.flyTo(latitude, longitude, 15);
  }, []);

  const renderRequest = useCallback(
    ({ item }: { item: Ride }) => (
      <IncomingRideCard
        ride={item}
        onAccept={handleAccept}
        onReject={handleReject}
        driverCustomRateCup={profile?.custom_per_km_rate_cup ?? null}
        serviceConfig={serviceConfigs[item.service_type] ?? null}
      />
    ),
    [handleAccept, handleReject, profile?.custom_per_km_rate_cup, serviceConfigs],
  );

  // ── Active trip — full-bleed map + DraggableSheet ────────────────────────
  if (activeTrip) {
    return (
      <Animated.View style={[styles.container, { opacity: tripFadeAnim }]}>
        {/* Layer 1: Full-screen map
            BUG-218: previously passed only `driverLocation` to RideMapView,
            so during an active trip the map showed neither pickup/dropoff
            markers nor the route polyline. The user reported "mapa sin
            marcadores ni linea de ruta". `useActiveTripMapData()` already
            existed and returns the correctly-shaped trip data (it's
            imported at the top of this file) — it was just never wired
            into the RideMapView props for the active-trip render path. */}
        <View style={StyleSheet.absoluteFillObject}>
          <ActiveTripMap
            mapRef={mapRef}
            driverLocation={driverLocation}
            onRecenter={handleRecenter}
            screenHeight={SCREEN_HEIGHT}
            followMode={followMode}
            onUserInteraction={handleUserMapInteraction}
          />
        </View>

        {/* Layer 2: Floating header */}
        <View style={[styles.floatingHeaderContainer, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          <FloatingHeader isOnline={isOnline} unreadCount={unreadCount} notifEnabled={notifCenterEnabled} t={t} />
        </View>

        {/* Layer 3: Trip DraggableSheet from bottom */}
        <DriverTripView />
      </Animated.View>
    );
  }

  // ── Idle / online / offline — Map + HomeBottomSheet ─────────────────────
  const firstRide = incomingRequests[0] ?? null;

  return (
    <View style={styles.container}>
      {/* ── Layer 1: Full-screen map ──
           V4 — `simpleMapMode` short-circuits the noisier overlays
           (surge polygons, demand-hotspot pulses, peer drivers). The
           driver's own marker, popular_locations (already toggle-gated),
           and active-trip context (when applicable) stay visible. We
           keep the data hooks running in the background so toggling
           back to full mode is instant — only the visual layers are
           suppressed. */}
      <View style={StyleSheet.absoluteFillObject}>
        <RideMapView
          ref={mapRef}
          driverLocation={driverLocation}
          driverHeading={idleHeading}
          nearbyDrivers={vehiclePreview ? previewVehicles : (simpleMapMode ? [] : nearbyDrivers)}
          demandHotspots={simpleMapMode ? [] : demandHotspots}
          popularLocations={popularLocations}
          height={SCREEN_HEIGHT}
          darkStyle
          onRecenter={handleRecenter}
          // Float the recenter button bottom-right, above the sheet, so it
          // never overlaps the "En Línea" header pill. 0.45 = HomeBottomSheet
          // default snap ('45%'); +16 lifts it just above the sheet's edge.
          recenterBottom={SCREEN_HEIGHT * 0.45 + 16}
          vehicleType={ownVehicleType}
        />
        {/* Subtle dim when offline */}
        {!isOnline && (
          <View style={styles.offlineDimOverlay} pointerEvents="none" />
        )}
      </View>

      {/* ── Layer 1.5: Top scrim ── Darkens the status-bar zone so the system
           clock and the map's own labels stay legible over the map. Before
           this, map labels + the Mapbox scale bar collided with the status
           bar. pointerEvents=none so map gestures pass straight through. */}
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(8,8,12,0.65)', 'rgba(8,8,12,0)']}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: insets.top + 56 }}
      />

      {/* ── Layer 2: Floating header + badges ── */}
      <View style={[styles.floatingHeaderContainer, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <FloatingHeader isOnline={isOnline} unreadCount={unreadCount} notifEnabled={notifCenterEnabled} t={t} />
      </View>

      {/* N5 — popular pickup/dropoff clusters toggle. Floats on the
           right edge just below the header. (The recenter button now
           floats bottom-right above the sheet — see RideMapView's
           recenterBottom — so it no longer shares this column.) Only
           visible while online — when offline the map overlay is hidden
           anyway, so the toggle would be pointless context. */}
      {isOnline && (
        <Pressable
          onPress={() => setPopularLocationsEnabled((p) => !p)}
          accessibilityRole="switch"
          accessibilityState={{ checked: popularLocationsEnabled }}
          accessibilityLabel={t('home.popular_zones_toggle', { defaultValue: 'Mostrar zonas populares' })}
          style={{
            position: 'absolute',
            top: insets.top + 64,
            right: 12,
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: popularLocationsEnabled
              ? '#FF4D00'
              : 'rgba(8, 8, 12, 0.7)',
            borderWidth: 1,
            borderColor: popularLocationsEnabled
              ? '#FF4D00'
              : 'rgba(255, 255, 255, 0.12)',
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.25,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 2 },
            elevation: 4,
          }}
        >
          <Ionicons
            name={popularLocationsEnabled ? 'pin' : 'pin-outline'}
            size={20}
            color="#FFFFFF"
          />
        </Pressable>
      )}

      {/* V4 — simple map mode toggle. Stacks below the popular zones
           toggle on the right edge. When ON, the busier overlays
           (surge polygons, demand pulses, peer drivers) and their
           top-of-screen banners are suppressed so the map reads as
           a calm navigation surface. Visual mirrors the popular zones
           toggle: filled icon when active, outline when off. */}
      {isOnline && (
        <Pressable
          onPress={toggleSimpleMapMode}
          accessibilityRole="switch"
          accessibilityState={{ checked: simpleMapMode }}
          accessibilityLabel={t('home.simple_map_toggle', { defaultValue: 'Modo de mapa simple' })}
          style={({ pressed }) => ({
            position: 'absolute',
            top: insets.top + 116,
            right: 12,
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: simpleMapMode
              ? '#FF4D00'
              : 'rgba(8, 8, 12, 0.7)',
            borderWidth: 1,
            borderColor: simpleMapMode
              ? '#FF4D00'
              : 'rgba(255, 255, 255, 0.12)',
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.25,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 2 },
            elevation: 4,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Ionicons
            name={simpleMapMode ? 'eye-off' : 'eye-off-outline'}
            size={20}
            color="#FFFFFF"
          />
        </Pressable>
      )}

      {/* Pre-launch QA — vehicle preview toggle. Dev/demo builds only
           (never rendered in production). When ON, the map shows
           synthetic moving vehicles so the team can preview how peer
           markers render before real drivers are online. */}
      {vehiclePreviewAvailable && (
        <Pressable
          onPress={toggleVehiclePreview}
          accessibilityRole="switch"
          accessibilityState={{ checked: vehiclePreview }}
          accessibilityLabel="Vehículos de prueba"
          style={({ pressed }) => ({
            position: 'absolute',
            top: insets.top + 220,
            right: 12,
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: vehiclePreview ? '#FF4D00' : 'rgba(8, 8, 12, 0.7)',
            borderWidth: 1,
            borderColor: vehiclePreview ? '#FF4D00' : 'rgba(255, 255, 255, 0.12)',
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.25,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 2 },
            elevation: 4,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Ionicons name="car-sport" size={20} color="#FFFFFF" />
        </Pressable>
      )}

      {/* Crowdsourcing — "Sugerir lugar" floating button.
           Lets the driver add a new POI from anywhere they are. Coords
           snapshot at the moment they tap so the form has stable input.
           Sits below the simple-map toggle on the right edge. */}
      {isOnline && driverLocation && (
        <Pressable
          onPress={() => {
            setSubmitPoiCoords({
              lat: driverLocation.latitude,
              lng: driverLocation.longitude,
            });
            setSubmitPoiOpen(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={t('home.suggest_poi', { defaultValue: 'Sugerir lugar nuevo' })}
          style={({ pressed }) => ({
            position: 'absolute',
            top: insets.top + 168,
            right: 12,
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: 'rgba(8, 8, 12, 0.7)',
            borderWidth: 1,
            borderColor: 'rgba(255, 255, 255, 0.12)',
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.25,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 2 },
            elevation: 4,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Ionicons name="add" size={26} color="#FFFFFF" />
        </Pressable>
      )}

      {/* SubmitPoiSheet — controlled by submitPoiOpen + submitPoiCoords */}
      {submitPoiCoords && (
        <SubmitPoiSheet
          visible={submitPoiOpen}
          onClose={() => setSubmitPoiOpen(false)}
          lat={submitPoiCoords.lat}
          lng={submitPoiCoords.lng}
          supabase={getSupabaseClient()}
        />
      )}

      {/* Top floating badges.
           UX: the old "Alta demanda" chip was vague — drivers couldn't tell
           if there's 1 hotspot or 20, or how far the nearest was. Now the
           banner states the count and, when we know it, the distance to the
           closest zone — information that actually helps the driver decide
           to move. Still non-interactive (map gestures).
           V4 — hidden in simple map mode (the underlying layer is also
           suppressed, so the banner would be lying about what's on screen). */}
      {isOnline && !simpleMapMode && demandHotspots.length > 0 && (
        <View
          style={{
            position: 'absolute',
            left: 16,
            right: 16,
            top: insets.top + 64,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            backgroundColor: 'rgba(255,77,0,0.18)',
            borderWidth: 1,
            borderColor: 'rgba(255,77,0,0.45)',
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 14,
          }}
          pointerEvents="none"
        >
          <Ionicons name="flame" size={20} color={colors.brand.orange} />
          <View style={{ flex: 1 }}>
            <RNText style={{ color: '#FFE4D3', fontSize: 14, fontWeight: '700', fontFamily: 'Inter' }}>
              {demandHotspots.length === 1
                ? t('home.hotspots_one', { defaultValue: '1 zona con alta demanda' })
                : t('home.hotspots_many', { count: demandHotspots.length, defaultValue: `${demandHotspots.length} zonas con alta demanda` })}
            </RNText>
            {nearestHotZone && (
              <RNText style={{ color: 'rgba(255,228,211,0.7)', fontSize: 11, fontFamily: 'Inter', marginTop: 2 }}>
                {t('home.hotspot_nearest', {
                  km: (nearestHotZone.distance / 1000).toFixed(1),
                  defaultValue: `Más cercana a ${(nearestHotZone.distance / 1000).toFixed(1)} km`,
                })}
              </RNText>
            )}
          </View>
        </View>
      )}

      {/* ── Layer 3: HomeBottomSheet (Midnight Ember v2) ── */}
      <HomeBottomSheet
        isOnline={isOnline}
        isOnBreak={isOnBreak}
        isIneligible={isIneligible}
        toggling={toggling}
        togglingBreak={togglingBreak}
        needsSelfieCheck={needsCheck || isProcessing}
        isSelfieProcessing={isProcessing}
        selfieLoading={selfieLoading}
        todayEarnings={todayEarnings}
        yesterdayEarnings={yesterdayEarnings}
        userName={user?.full_name?.split(' ')[0] ?? user?.full_name}
        navCountdown={navCountdown}
        nearestHotZone={nearestHotZone}
        nearestHotspot={nearestHotspot}
        fatigueLevel={fatigueLevel}
        sessionHours={sessionHours}
        onToggleOnline={handleToggleOnline}
        onToggleBreak={handleToggleBreak}
        onSubmitSelfie={submitSelfie}
        onCancelAutoNav={cancelAutoNav}
        onAddressSelect={handleAddressSelect}
        onGoToSuggestion={(lat, lng) => {
          trackValidationEvent('driver_suggestion_followed', {
            distance_km: nearestHotspot?.distance,
            live_count: nearestHotspot?.liveCount,
          });
          openNavigation(lat, lng);
        }}
        ctaScaleAnim={ctaScaleAnim}
        onCtaPressIn={onCtaPressIn}
        onCtaPressOut={onCtaPressOut}
      />

      {/* ── Layer 4: Incoming ride modal overlay ── */}
      {firstRide && !activeTrip && (
        <View style={styles.incomingOverlay} pointerEvents="box-none">
          <View style={styles.incomingOverlayDim} />
          <View style={styles.incomingCardContainer}>
            <IncomingRideCard
              ride={firstRide}
              onAccept={() => handleAccept(firstRide.id)}
              onReject={() => handleReject(firstRide.id)}
              driverCustomRateCup={profile?.custom_per_km_rate_cup ?? null}
              serviceConfig={serviceConfigs[firstRide.service_type] ?? null}
            />
            {incomingRequests.length > 1 && (
              <FlatList
                data={incomingRequests.slice(1)}
                renderItem={renderRequest}
                keyExtractor={(item) => item.id}
                showsVerticalScrollIndicator={false}
                style={{ marginTop: 8, maxHeight: 160 }}
              />
            )}
          </View>
        </View>
      )}
    </View>
  );
}

// ─── Floating Header ───────────────────────────────────────────────────────────
interface FloatingHeaderProps {
  isOnline: boolean;
  unreadCount: number;
  notifEnabled: boolean;
  t: (key: string, opts?: any) => string;
}

function FloatingHeader({ isOnline, unreadCount, notifEnabled, t }: FloatingHeaderProps) {
  return (
    <View style={styles.floatingHeader} pointerEvents="box-none">
      {/* Logo */}
      <View style={[styles.logoCard, Platform.OS === 'web' && { backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' } as any]}>
        <Image
          source={require('../../assets/logo-wordmark-white.png')}
          style={{ width: 76, height: 24 }}
          resizeMode="contain"
        />
        <View style={styles.logoDivider} />
        <RNText numberOfLines={1} style={styles.logoSub}>{t('common.driver_label', { defaultValue: 'conductor' })}</RNText>
      </View>

      {/* Right actions */}
      <View style={styles.headerActions}>
        {/* Language Switcher */}
        <LanguageSwitcher variant="pill" />

        {notifEnabled && (
          <Pressable
            style={styles.headerActionBtn}
            onPress={() => router.push('/notifications')}
            accessibilityRole="button"
            accessibilityLabel={unreadCount > 0 ? `${t('notifications.title')}, ${unreadCount}` : t('notifications.title')}
          >
            <Ionicons
              name={unreadCount > 0 ? 'notifications' : 'notifications-outline'}
              size={20}
              color="#fff"
            />
            {unreadCount > 0 && (
              <View style={styles.notifBadge}>
                <RNText style={styles.notifBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</RNText>
              </View>
            )}
          </Pressable>
        )}

        {/* Online status pill */}
        <View style={[styles.statusPill, isOnline ? styles.statusPillOnline : styles.statusPillOffline]}>
          <View style={[styles.statusDot, { backgroundColor: isOnline ? '#22c55e' : '#737373' }]} />
          <RNText numberOfLines={1} style={[styles.statusPillText, { color: isOnline ? '#4ade80' : '#9ca3af' }]}>
            {isOnline ? t('home.online') : t('home.offline')}
          </RNText>
        </View>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  // ════════════════════════════════════════════════════════════════════════════
  // MIDNIGHT EMBER — Premium dark theme with warm orange accents
  // ════════════════════════════════════════════════════════════════════════════

  container: {
    flex: 1,
    backgroundColor: '#0d0d1a',
  },

  // ── Offline dim overlay ──
  // PR E (2026-05-12): reduced from 0.45 → 0.18 because at 45% combined
  // with `darkStyle={true}` (navigation-night-v1) the offline map looked
  // almost pure black, especially on first install when the style/tiles
  // had not yet streamed in. Driver-Offline state is already communicated
  // by the bottom-sheet "CONECTARSE" CTA and the "Fuera de servicio"
  // header pill, so the dim is purely a "tonally calmer than online"
  // hint — 18% is enough to read it without hiding the map.
  offlineDimOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },

  // ── Header ──
  floatingHeaderContainer: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    zIndex: 10,
  },
  floatingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  logoCard: {
    flexDirection: 'row',
    flexShrink: 1,
    minWidth: 0,
    alignItems: 'center',
    backgroundColor: 'rgba(17,23,42,0.92)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
    gap: 0,
    borderWidth: 1,
    borderColor: 'rgba(244,240,234,0.08)',
  },
  logoTrici: {
    fontSize: 20,
    fontWeight: '800',
    color: '#fff',
    fontFamily: 'Inter',
    letterSpacing: -0.5,
  },
  logoGo: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.brand.orange,
    fontFamily: 'Inter',
    letterSpacing: -0.5,
    marginRight: 6,
  },
  logoDivider: {
    width: 1,
    height: 14,
    backgroundColor: 'rgba(244,240,234,0.12)',
    marginHorizontal: 6,
    alignSelf: 'center',
  },
  logoSub: {
    fontSize: 11,
    fontWeight: '500',
    color: 'rgba(244,240,234,0.5)',
    fontFamily: 'Inter',
    alignSelf: 'flex-end',
    marginBottom: 1,
    flexShrink: 1,
  },
  headerActions: {
    flexDirection: 'row',
    flexShrink: 0,
    alignItems: 'center',
    gap: 10,
  },
  headerActionBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(14,14,26,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  notifBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  notifBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
  },
  statusPillOnline: {
    backgroundColor: 'rgba(34,197,94,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.35)',
    ...Platform.select({
      web: { boxShadow: '0 0 8px rgba(34,197,94,0.4)' } as any,
      default: { shadowColor: '#22c55e', shadowOpacity: 0.4, shadowRadius: 8, elevation: 4 },
    }),
  },
  statusPillOffline: {
    backgroundColor: 'rgba(14,14,26,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusPillText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter',
  },

  // ── Heatmap badge ──
  heatmapBadge: {
    position: 'absolute',
    left: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,77,0,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,77,0,0.3)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  heatmapBadgeText: {
    color: colors.brand.orange,
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Inter',
  },

  // ── Bottom panel (gradient — no hard edge) ──
  bottomPanelGradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 50,
  },

  // ── Banners ──
  alertBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(26,5,5,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.25)',
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
  },
  alertText: {
    color: '#fca5a5',
    fontSize: 13,
    fontFamily: 'Inter',
    lineHeight: 18,
  },
  alertLink: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter',
    marginTop: 4,
  },
  omegaBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(26,17,0,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.25)',
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
  },
  omegaBannerTitle: {
    color: '#fcd34d',
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter',
  },
  omegaBannerSub: {
    color: '#9ca3af',
    fontSize: 11,
    fontFamily: 'Inter',
    marginTop: 2,
  },
  omegaCancelBtn: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  omegaCancelText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter',
  },

  // ── Offline greeting (dramatic typography) ──
  offlineGreeting: {
    alignItems: 'center',
    marginBottom: 10,
    paddingTop: 8,
  },
  greetingPrefix: {
    fontSize: 14,
    fontWeight: '500',
    color: '#FF8A5C',
    fontFamily: 'Inter',
    letterSpacing: 6,
    textTransform: 'uppercase',
  },
  greetingName: {
    fontSize: 42,
    fontWeight: '900',
    color: '#ffffff',
    fontFamily: 'Inter',
    letterSpacing: 4,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  greetingMotivation: {
    fontSize: 13,
    fontWeight: '400',
    color: 'rgba(255,255,255,0.4)',
    fontFamily: 'Inter',
    letterSpacing: 1,
  },

  // ── Radar sweep searching indicator ──
  radarContainer: {
    alignItems: 'center',
    marginBottom: 14,
  },
  radarTrack: {
    width: '80%',
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 1,
    overflow: 'hidden',
    marginBottom: 10,
  },
  radarSweep: {
    position: 'absolute',
    width: 80,
    height: 2,
  },
  radarSweepGradient: {
    flex: 1,
    borderRadius: 1,
  },
  searchingText: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 13,
    fontFamily: 'Inter',
  },

  // ── Search bar wrapper (orange accent) ──
  searchBarWrapper: {
    marginBottom: 12,
    borderLeftWidth: 2,
    borderLeftColor: '#FF4D00',
    borderRadius: 12,
    overflow: 'hidden',
  },

  // ── Stat cards (individual earnings) ──
  earningsCards: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: 'rgba(20,20,30,0.85)',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  statCardAccent: {
    borderColor: 'rgba(255,77,0,0.25)',
  },
  statCardLabel: {
    fontSize: 11,
    color: '#6b7280',
    fontFamily: 'Inter',
    fontWeight: '500',
    marginTop: 6,
    marginBottom: 3,
  },
  statCardValue: {
    fontSize: 20,
    color: '#fff',
    fontFamily: 'Inter',
    fontWeight: '700',
  },

  // ── Break banner ──
  breakBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(245,158,11,0.1)',
    borderRadius: 12,
    paddingVertical: 7,
    paddingHorizontal: 12,
    marginBottom: 10,
  },
  breakBannerText: {
    color: '#fbbf24',
    fontSize: 12,
    fontFamily: 'Inter',
    fontWeight: '500',
  },

  // ── CTA "The Ignition Portal" ──
  ctaCircleContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    marginBottom: 6,
    paddingVertical: 10,
  },
  ctaRing: {
    position: 'absolute',
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 1.5,
    borderColor: '#FF4D00',
  },
  ctaCircle: {
    width: 130,
    height: 130,
    borderRadius: 65,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: { boxShadow: '0 0 40px rgba(255,77,0,0.5), 0 0 80px rgba(255,77,0,0.2), inset 0 0 30px rgba(255,140,92,0.15)' } as any,
      default: { shadowColor: '#FF4D00', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6, shadowRadius: 30, elevation: 15 },
    }),
  },
  ctaCircleOnline: {
    width: 70,
    height: 70,
    borderRadius: 35,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15,15,25,0.95)',
    borderWidth: 2,
    borderColor: 'rgba(239,68,68,0.5)',
  },
  ctaLabel: {
    color: '#FF8A5C',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter',
    letterSpacing: 4,
    textTransform: 'uppercase',
    marginTop: 20,
  },
  ctaLabelOnline: {
    color: '#ef4444',
    letterSpacing: 2,
    fontSize: 11,
    marginTop: 12,
  },
  toggleBtnDisabled: {
    opacity: 0.5,
  },

  // ── Break button ──
  breakBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    paddingVertical: 11,
    marginBottom: 4,
  },
  breakBtnActive: {
    backgroundColor: colors.brand.orange,
  },
  breakBtnInactive: {
    backgroundColor: 'rgba(20,20,30,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  breakBtnText: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'Inter',
    color: '#9ca3af',
  },

  // ── Incoming ride overlay ──
  incomingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  incomingOverlayDim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.8)',
  },
  incomingCardContainer: {
    position: 'relative',
    zIndex: 101,
  },
});

// ─── Root export ──────────────────────────────────────────────────────────────
export default function DriverHomeScreen() {
  return <NativeDriverHomeScreen />;
}
