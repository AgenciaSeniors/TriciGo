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
  ScrollView,
  Text as RNText,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { driverService, getSupabaseClient, useFeatureFlag, notificationService } from '@tricigo/api';
import {
  HAVANA_CENTER,
  trackEvent,
  trackValidationEvent,
  haversineDistance,
  logger,
  getErrorMessage,
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
import { DriverTripView } from '@/components/DriverTripView';
import { useDriverLocationTracking } from '@/hooks/useDriverLocation';
import * as Location from 'expo-location';
import { useDemandHeatmap } from '@/hooks/useDemandHeatmap';
import { useSurgeZones } from '@/hooks/useSurgeZones';
import { useSelfieCheck } from '@/hooks/useSelfieCheck';
import { RideMapView } from '@/components/RideMapView';
import type { RideMapViewRef } from '@/components/RideMapView';
import { AddressSearchBar } from '@/components/AddressSearchBar';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '@tricigo/theme';
import type { Ride } from '@tricigo/types';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

// ─── Static web screen (Play Store screenshots) ───────────────────────────────
function WebDriverHomeScreen() {
  const font = { fontFamily: 'Montserrat, system-ui, sans-serif' };
  return (
    <View style={{ flex: 1, backgroundColor: '#111111' }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
      <View style={{ paddingTop: 16 }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <Text style={{ fontSize: 24, fontWeight: '700', color: '#fff', ...font }}>Conductor</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(34,197,94,0.2)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#22c55e' }} />
            <Text style={{ fontSize: 14, color: '#4ade80', fontWeight: '600', ...font }}>En línea</Text>
          </View>
        </View>
        <View style={{ height: 200, borderRadius: 16, overflow: 'hidden', position: 'relative', marginBottom: 12 }}>
          <Image
            source={require('../../assets/screenshots/map-havana-dark.png')}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
          <View style={{ position: 'absolute', top: 80, left: 170 }}>
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(30,136,229,0.25)', alignItems: 'center', justifyContent: 'center' }}>
              <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: '#1e88e5', borderWidth: 3, borderColor: '#fff' }} />
            </View>
          </View>
          <View style={{ position: 'absolute', top: 25, left: 70, width: 60, height: 50, borderRadius: 25, backgroundColor: 'rgba(249,115,22,0.15)' }} />
          <View style={{ position: 'absolute', top: 110, left: 260, width: 80, height: 55, borderRadius: 30, backgroundColor: 'rgba(249,115,22,0.2)' }} />
          <View style={{ position: 'absolute', top: 8, right: 12, backgroundColor: 'rgba(249,115,22,0.2)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Ionicons name="flame" size={12} color={colors.brand.orange} />
            <Text style={{ color: colors.brand.orange, fontSize: 11, fontWeight: '600', ...font }}>Alta demanda</Text>
          </View>
        </View>
        <View style={{ backgroundColor: '#1f1f1f', borderRadius: 16, padding: 16, marginBottom: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View>
            <Text style={{ fontSize: 12, color: '#9ca3af', ...font }}>Ganancias de hoy</Text>
            <Text style={{ fontSize: 24, fontWeight: '700', color: '#fff', ...font }}>T$ 1,250.00</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ fontSize: 12, color: '#9ca3af', ...font }}>Viajes</Text>
            <Text style={{ fontSize: 20, fontWeight: '700', color: '#fff', ...font }}>8</Text>
          </View>
        </View>
        <Text style={{ fontSize: 18, fontWeight: '700', color: '#fff', marginBottom: 12, ...font }}>Solicitud entrante</Text>
        <View style={{ backgroundColor: '#1f1f1f', borderRadius: 12, padding: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 }}>
            <View style={{ alignItems: 'center', marginRight: 12, marginTop: 4 }}>
              <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#22c55e' }} />
              <View style={{ width: 2, height: 24, backgroundColor: '#4b5563', marginVertical: 4 }} />
              <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.brand.orange }} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, color: '#fff', marginBottom: 8, ...font }}>Calle 23 esq. L, Vedado</Text>
              <Text style={{ fontSize: 14, color: '#d1d5db', ...font }}>Parque Central, Habana Vieja</Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, borderTopWidth: 1, borderTopColor: '#252540' }}>
            <Text style={{ fontSize: 16, color: '#fff', fontWeight: '700', ...font }}>T$ 85.00</Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Text style={{ fontSize: 12, color: '#9ca3af', ...font }}>3.2 km</Text>
              <Text style={{ fontSize: 12, color: '#9ca3af', ...font }}>12 min</Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
            <Pressable style={{ flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#6b7280', alignItems: 'center' }}>
              <Text style={{ fontSize: 14, color: '#d1d5db', fontWeight: '600', ...font }}>Rechazar</Text>
            </Pressable>
            <Pressable style={{ flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: colors.brand.orange, alignItems: 'center' }}>
              <Text style={{ fontSize: 14, color: '#fff', fontWeight: '600', ...font }}>Aceptar</Text>
            </Pressable>
          </View>
        </View>
      </View>
      </ScrollView>
    </View>
  );
}

// ─── Native home screen ────────────────────────────────────────────────────────
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

  // DE-1.2: Preferred navigation memory
  const [preferredNav, setPreferredNav] = useState<'inapp' | 'external'>('external');

  useEffect(() => {
    AsyncStorage.getItem('preferred_nav').then((val) => {
      if (val === 'inapp' || val === 'external') setPreferredNav(val);
    }).catch(() => {});
  }, []);

  // DT-2: Today's earnings state
  const [todayEarnings, setTodayEarnings] = useState({ amount: 0, trips: 0 });

  // DT-2: Crossfade animation for trip transitions
  const tripFadeAnim = useRef(new Animated.Value(1)).current;
  const prevHadTrip = useRef(!!activeTrip);

  // Pulsing "searching" signal during idle
  const searchPulseAnim = useRef(new Animated.Value(1)).current;

  // ── Midnight Ember animations ──
  const ring1Anim = useRef(new Animated.Value(0)).current;
  const ring2Anim = useRef(new Animated.Value(0)).current;
  const ring3Anim = useRef(new Animated.Value(0)).current;
  const radarSweepAnim = useRef(new Animated.Value(0)).current;
  const ctaScaleAnim = useRef(new Animated.Value(1)).current;

  // Map ref for imperative camera control
  const mapRef = useRef<RideMapViewRef>(null);

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

  // DT-2: Fetch today's earnings when online
  useEffect(() => {
    if (!isOnline) return;
    const fetchEarnings = async () => {
      try {
        const supabase = getSupabaseClient();
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const { data } = await supabase
          .from('ledger_entries')
          .select('amount, entry_type')
          .eq('user_id', profile?.user_id)
          .gte('created_at', today.toISOString())
          .in('entry_type', ['ride_payment_credit', 'tip_credit', 'bonus_credit']);
        if (data) {
          const amount = data.reduce((sum: number, e: { amount: number }) => sum + Math.abs(e.amount), 0);
          const trips = data.filter((e: { entry_type: string }) => e.entry_type === 'ride_payment_credit').length;
          setTodayEarnings({ amount, trips });
        }
      } catch {}
    };
    fetchEarnings();
  }, [isOnline, profile?.user_id]);

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

  // Pulsing search animation when idle
  useEffect(() => {
    if (isOnline && !activeTrip && incomingRequests.length === 0) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(searchPulseAnim, { toValue: 0.3, duration: 1000, useNativeDriver: true }),
          Animated.timing(searchPulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
        ])
      ).start();
    } else {
      searchPulseAnim.setValue(1);
    }
  }, [isOnline, activeTrip, incomingRequests.length]);

  // ── Ignition Portal: Staggered 3-ring pulse (offline) ──
  useEffect(() => {
    if (!isOnline) {
      const createRing = (anim: Animated.Value, delay: number) =>
        Animated.loop(Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, { toValue: 1, duration: 2000, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]));
      const a1 = createRing(ring1Anim, 0);
      const a2 = createRing(ring2Anim, 600);
      const a3 = createRing(ring3Anim, 1200);
      a1.start(); a2.start(); a3.start();
      return () => { a1.stop(); a2.stop(); a3.stop(); };
    } else {
      ring1Anim.setValue(0);
      ring2Anim.setValue(0);
      ring3Anim.setValue(0);
    }
  }, [isOnline]);

  // ── Midnight Ember: Radar sweep (online idle) ──
  useEffect(() => {
    if (isOnline && !activeTrip && incomingRequests.length === 0) {
      Animated.loop(
        Animated.timing(radarSweepAnim, { toValue: 1, duration: 2000, useNativeDriver: true })
      ).start();
    } else {
      radarSweepAnim.setValue(0);
    }
  }, [isOnline, activeTrip, incomingRequests.length]);

  // ── Midnight Ember: CTA press spring ──
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
    (async () => {
      try {
        const count = await notificationService.getUnreadCount(user.id);
        if (!cancelled) setUnreadCount(count);
      } catch (err) { console.warn('[Notif] Failed to load unread count:', err); }
    })();
    const subscription = notificationService.subscribeToNotifications(user.id, () => {
      if (!cancelled) incrementUnread();
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

  // Demand heatmap data
  const heatmapData = useDemandHeatmap(isOnline);

  // Active surge zones (only when online and no active trip)
  const surgeZones = useSurgeZones(isOnline && !activeTrip);

  // Selfie verification check
  const { needsCheck, isProcessing, loading: selfieLoading, submitSelfie, check: selfieCheck } = useSelfieCheck();

  const { acceptRide } = useDriverRideActions();

  // Driver's current GPS location
  const driverLat = useLocationStore((s) => s.latitude);
  const driverLng = useLocationStore((s) => s.longitude);

  const driverLocation = useMemo(
    () => (driverLat && driverLng ? { latitude: driverLat, longitude: driverLng } : null),
    [driverLat, driverLng],
  );

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
        if (mins >= 10 && heatmapData.length > 0 && driverLat && driverLng) {
          const hotZones = heatmapData
            .filter((p: any) => p.intensity > 0.7)
            .map((p: any) => ({
              lat: p.latitude,
              lng: p.longitude,
              distance: Math.round(haversineDistance(
                { latitude: driverLat, longitude: driverLng },
                { latitude: p.latitude, longitude: p.longitude },
              ) / 100) / 10,
            }))
            .sort((a: any, b: any) => a.distance - b.distance);
          if (hotZones.length > 0 && hotZones[0]) setNearestHotZone(hotZones[0]);
        }
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [isOnline, activeTrip, incomingRequests.length, isOnBreak, idleSince, heatmapData, driverLat, driverLng]);

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

  // OMEGA: Wait time estimate based on heatmap proximity
  const estimatedWaitMinutes = useMemo(() => {
    if (!heatmapData.length || !driverLat || !driverLng) return null;
    const nearest = heatmapData
      .map((p: any) => ({
        ...p,
        dist: haversineDistance(
          { latitude: driverLat, longitude: driverLng },
          { latitude: p.latitude, longitude: p.longitude },
        ),
      }))
      .sort((a: any, b: any) => a.dist - b.dist)[0];
    if (!nearest || nearest.dist > 2000) return null;
    if (nearest.intensity > 0.8) return 3;
    if (nearest.intensity > 0.5) return 8;
    if (nearest.intensity > 0.2) return 15;
    return null;
  }, [heatmapData, driverLat, driverLng]);

  // OMEGA: Online time tracking for earnings per hour
  useEffect(() => {
    if (isOnline && !onlineSince) {
      AsyncStorage.getItem('driver_online_since').then(val => {
        if (val) {
          const parsed = parseInt(val, 10);
          if (!isNaN(parsed) && parsed > 0) setOnlineSince(parsed);
          else setOnlineSince(Date.now());
        } else {
          setOnlineSince(Date.now());
        }
      }).catch(() => setOnlineSince(Date.now()));
    } else if (isOnline && onlineSince) {
      AsyncStorage.setItem('driver_online_since', String(onlineSince)).catch(() => {});
    } else if (!isOnline) {
      setOnlineSince(null);
      AsyncStorage.removeItem('driver_online_since').catch(() => {});
    }
  }, [isOnline]);

  const hoursOnline = onlineSince ? Math.max((Date.now() - onlineSince) / 3600000, 0.1) : 0;
  const perHour = hoursOnline >= 0.5 ? Math.round(todayEarnings.amount / hoursOnline) : 0;

  // ── Handlers ──────────────────────────────────────────────────────────────────
  const handleToggleOnline = useCallback(async () => {
    if (toggling) return;
    if (!profile) {
      Toast.show({ type: 'error', text1: t('common.error'), text2: t('common.status_change_failed') });
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
      await driverService.setOnlineStatus(profile.id, newStatus, newStatus ? HAVANA_CENTER : undefined);
      setOnline(newStatus);
      trackEvent(newStatus ? 'driver_went_online' : 'driver_went_offline');
    } catch {
      Toast.show({ type: 'error', text1: t('common.status_change_failed') });
    } finally {
      setToggling(false);
    }
  }, [profile, isOnline, setOnline, activeTrip]);

  const handleToggleBreak = useCallback(async () => {
    if (!profile || togglingBreak) return;
    if (activeTrip) {
      Toast.show({ type: 'error', text1: t('driver.cannot_break_active_ride', { defaultValue: 'No puedes descansar durante un viaje activo' }) });
      return;
    }
    setTogglingBreak(true);
    try {
      const newBreakStatus = !isOnBreak;
      await driverService.setBreakStatus(profile.id, newBreakStatus);
      setIsOnBreak(newBreakStatus);
      trackEvent(newBreakStatus ? 'driver_break_started' : 'driver_break_ended');
    } catch {
      Toast.show({ type: 'error', text1: t('common.status_change_failed') });
    } finally {
      setTogglingBreak(false);
    }
  }, [profile, isOnBreak, togglingBreak, activeTrip]);

  const handleAccept = useCallback((rideId: string) => acceptRide(rideId), [acceptRide]);
  const handleReject = useCallback((rideId: string) => removeRequest(rideId), [removeRequest]);

  const handleRecenter = useCallback(() => {
    if (driverLocation) {
      mapRef.current?.flyTo(driverLocation.latitude, driverLocation.longitude, 15);
    }
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

  // ── Active trip — full screen with map behind ──────────────────────────────
  if (activeTrip) {
    return (
      <Animated.View style={[styles.container, { opacity: tripFadeAnim }]}>
        <View style={StyleSheet.absoluteFillObject}>
          <RideMapView
            ref={mapRef}
            driverLocation={driverLocation}
            height={SCREEN_HEIGHT}
            darkStyle
            onRecenter={handleRecenter}
            vehicleType="triciclo"
          />
        </View>
        <View style={[StyleSheet.absoluteFillObject]} pointerEvents="box-none">
          <LinearGradient
            colors={['rgba(13,13,26,0.9)', 'transparent']}
            style={[styles.tripHeaderGradient, { paddingTop: insets.top }]}
            pointerEvents="box-none"
          >
            <FloatingHeader isOnline={isOnline} unreadCount={unreadCount} notifEnabled={notifCenterEnabled} t={t} />
          </LinearGradient>
          <View style={{ flex: 1, paddingHorizontal: 0 }}>
            <DriverTripView />
          </View>
        </View>
      </Animated.View>
    );
  }

  // ── Idle / online / offline states ────────────────────────────────────────
  const firstRide = incomingRequests[0] ?? null;

  return (
    <View style={styles.container}>
      {/* ── Layer 1: Full-screen map ── */}
      <View style={StyleSheet.absoluteFillObject}>
        <RideMapView
          ref={mapRef}
          driverLocation={driverLocation}
          heatmapData={heatmapData}
          surgeZones={surgeZones.filter((z) => z.boundary !== null).map((z) => ({ multiplier: z.multiplier, zone_name: z.zone_name, boundary: z.boundary! }))}
          height={SCREEN_HEIGHT}
          darkStyle
          onRecenter={handleRecenter}
          vehicleType="triciclo"
        />
        {/* Dim + warm orange overlay when offline */}
        {!isOnline && (
          <>
            <View style={styles.offlineDimOverlay} pointerEvents="none" />
            <LinearGradient
              colors={['transparent', 'transparent', 'rgba(255,77,0,0.06)', 'rgba(255,77,0,0.12)']}
              locations={[0, 0.5, 0.8, 1]}
              style={StyleSheet.absoluteFillObject}
              pointerEvents="none"
            />
          </>
        )}
      </View>

      {/* ── Layer 2: Overlay content ── */}
      <View style={[StyleSheet.absoluteFillObject]} pointerEvents="box-none">

        {/* Top: floating header with gradient fade */}
        <LinearGradient
          colors={['rgba(13,13,26,0.85)', 'transparent']}
          style={[styles.tripHeaderGradient, { paddingTop: insets.top + 8 }]}
          pointerEvents="box-none"
        >
          <FloatingHeader isOnline={isOnline} unreadCount={unreadCount} notifEnabled={notifCenterEnabled} t={t} />
        </LinearGradient>

        {/* Top badges: heatmap indicator */}
        {isOnline && heatmapData.length > 0 && (
          <View style={[styles.heatmapBadge, { top: insets.top + 64 }]} pointerEvents="none">
            <Ionicons name="flame" size={12} color={colors.brand.orange} />
            <RNText style={styles.heatmapBadgeText}>{t('home.high_demand', { defaultValue: 'Alta demanda' })}</RNText>
          </View>
        )}

        {/* Surge zone badge */}
        {isOnline && surgeZones.length > 0 && (
          <View
            style={[
              styles.heatmapBadge,
              { top: insets.top + (heatmapData.length > 0 ? 92 : 64), backgroundColor: 'rgba(239,68,68,0.15)', borderColor: 'rgba(239,68,68,0.3)' },
            ]}
            pointerEvents="none"
          >
            <Ionicons name="trending-up" size={12} color="#ef4444" />
            <RNText style={[styles.heatmapBadgeText, { color: '#fca5a5' }]}>
              {t('home.surge_active', {
                defaultValue: `Tarifa dinamica ${Math.max(...surgeZones.map((z) => z.multiplier)).toFixed(1)}x`,
                multiplier: Math.max(...surgeZones.map((z) => z.multiplier)).toFixed(1),
              })}
            </RNText>
          </View>
        )}

        {/* Bottom: gradient panel that fades from map */}
        <LinearGradient
          colors={['transparent', 'rgba(13,13,26,0.5)', 'rgba(13,13,26,0.92)', '#0d0d1a']}
          locations={[0, 0.12, 0.35, 1]}
          style={[styles.bottomPanelGradient, { paddingBottom: insets.bottom + 16 }]}
          pointerEvents="box-none"
        >

          {/* Alert banners */}
          {isIneligible && (
            <View style={styles.alertBanner} accessibilityRole="alert" accessibilityLiveRegion="polite">
              <Ionicons name="warning-outline" size={16} color="#fca5a5" style={{ marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <RNText style={styles.alertText}>{t('home.ineligible_banner')}</RNText>
                <Pressable onPress={() => router.push('/(tabs)/earnings')}>
                  <RNText style={styles.alertLink}>{t('home.ineligible_recharge')}</RNText>
                </Pressable>
              </View>
            </View>
          )}

          {(needsCheck || isProcessing) && (
            <View style={[styles.alertBanner, { borderColor: '#f59e0b40', backgroundColor: '#1a1300' }]} accessibilityRole="alert">
              <Ionicons name="camera-outline" size={16} color="#f59e0b" style={{ marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <RNText style={[styles.alertText, { color: '#fcd34d' }]}>{t('verification.selfie_required')}</RNText>
                {!isProcessing && (
                  <Pressable onPress={submitSelfie} disabled={selfieLoading}>
                    <RNText style={[styles.alertLink, { color: '#f59e0b' }]}>{t('verification.take_selfie')}</RNText>
                  </Pressable>
                )}
                {isProcessing && (
                  <RNText style={[styles.alertText, { opacity: 0.7 }]}>{t('verification.processing')}</RNText>
                )}
              </View>
            </View>
          )}

          {/* OMEGA: Auto-nav countdown banner */}
          {navCountdown !== null && nearestHotZone && (
            <View style={styles.omegaBanner}>
              <Ionicons name="navigate" size={16} color="#f59e0b" />
              <View style={{ flex: 1, marginLeft: 8 }}>
                <RNText style={styles.omegaBannerTitle}>
                  {t('home.high_demand_zone', { seconds: navCountdown, defaultValue: 'Navegando a zona en {{seconds}}s' })}
                </RNText>
                <RNText style={styles.omegaBannerSub}>
                  {t('home.active_zone_nearby', { distance: nearestHotZone.distance })}
                </RNText>
              </View>
              <Pressable style={styles.omegaCancelBtn} onPress={cancelAutoNav}>
                <RNText style={styles.omegaCancelText}>{t('home.stay_here', { defaultValue: 'Quedar' })}</RNText>
              </Pressable>
            </View>
          )}

          {/* Greeting + motivational (offline only) */}
          {!isOnline && (
            <View style={styles.offlineGreeting}>
              {user?.full_name ? (
                <>
                  <RNText style={styles.greetingPrefix}>HOLA,</RNText>
                  <RNText style={styles.greetingName}>
                    {(user.full_name.split(' ')[0] ?? user.full_name).toUpperCase()}
                  </RNText>
                </>
              ) : (
                <RNText style={styles.greetingName}>
                  {t('home.greeting_generic', { defaultValue: '¡BIENVENIDO!' })}
                </RNText>
              )}
              <RNText style={styles.greetingMotivation}>
                {t('home.connect_to_earn', { defaultValue: 'Conectate para empezar a ganar' })}
              </RNText>
            </View>
          )}

          {/* Radar sweep searching indicator (online, idle) */}
          {isOnline && !activeTrip && incomingRequests.length === 0 && (
            <View style={styles.radarContainer}>
              <View style={styles.radarTrack}>
                <Animated.View style={[styles.radarSweep, {
                  transform: [{
                    translateX: radarSweepAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-80, 280],
                    }),
                  }],
                }]}>
                  <LinearGradient
                    colors={['transparent', '#22c55e', 'transparent']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={styles.radarSweepGradient}
                  />
                </Animated.View>
              </View>
              <RNText style={styles.searchingText}>
                {t('home.searching_rides', { defaultValue: 'Buscando viajes cerca de ti...' })}
                {estimatedWaitMinutes ? `  · ~${estimatedWaitMinutes} min` : ''}
              </RNText>
            </View>
          )}

          {/* Address search bar with orange accent (online only) */}
          {isOnline && (
            <View style={styles.searchBarWrapper}>
              <AddressSearchBar
                onSelect={handleAddressSelect}
                placeholder={t('home.search_placeholder', { defaultValue: 'Buscar dirección o zona...' })}
              />
            </View>
          )}

          {/* Earnings stat cards (online) */}
          {isOnline && (
            <View style={styles.earningsCards}>
              <View style={styles.statCard}>
                <Ionicons name="trending-up" size={16} color="#FF8A5C" />
                <RNText style={styles.statCardLabel}>{t('home.today', { defaultValue: 'Hoy' })}</RNText>
                <RNText style={styles.statCardValue}>
                  ₧{todayEarnings.amount.toLocaleString()}
                </RNText>
              </View>
              <View style={styles.statCard}>
                <Ionicons name="car-outline" size={16} color="#FF8A5C" />
                <RNText style={styles.statCardLabel}>{t('home.trips_label', { defaultValue: 'Viajes' })}</RNText>
                <RNText style={styles.statCardValue}>{todayEarnings.trips}</RNText>
              </View>
              {perHour > 0 && (
                <View style={[styles.statCard, styles.statCardAccent]}>
                  <Ionicons name="time-outline" size={16} color={colors.brand.orange} />
                  <RNText style={styles.statCardLabel}>{t('home.per_hour_label', { defaultValue: 'Por hora' })}</RNText>
                  <RNText style={[styles.statCardValue, { color: colors.brand.orange }]}>
                    ₧{perHour.toLocaleString()}
                  </RNText>
                </View>
              )}
            </View>
          )}

          {/* Break banner */}
          {isOnline && isOnBreak && (
            <View style={styles.breakBanner}>
              <Ionicons name="cafe-outline" size={14} color="#f59e0b" />
              <RNText style={styles.breakBannerText}>
                {t('home.on_break_label', { defaultValue: 'En descanso — no recibes solicitudes' })}
              </RNText>
            </View>
          )}

          {/* ── CTA "The Ignition Portal" ── */}
          <View style={styles.ctaCircleContainer}>
            {/* 3 concentric pulse rings */}
            {!isOnline && (
              <>
                {[ring1Anim, ring2Anim, ring3Anim].map((anim, i) => (
                  <Animated.View key={i} style={[styles.ctaRing, {
                    opacity: anim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.5 - i * 0.12, 0] }),
                    transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8 - i * 0.25] }) }],
                  }]} />
                ))}
              </>
            )}

            <Animated.View style={{ transform: [{ scale: ctaScaleAnim }] }}>
              <Pressable
                onPressIn={onCtaPressIn}
                onPressOut={onCtaPressOut}
                onPress={handleToggleOnline}
                disabled={toggling}
                accessibilityRole="switch"
                accessibilityState={{ checked: isOnline, disabled: toggling }}
                accessibilityLabel={isOnline ? t('home.go_offline') : t('home.go_online')}
                style={toggling ? styles.toggleBtnDisabled : undefined}
              >
                {!isOnline ? (
                  <LinearGradient
                    colors={['#FF6B2C', '#FF4D00', '#CC3D00']}
                    style={styles.ctaCircle}
                  >
                    <Ionicons name="power" size={38} color="#fff" />
                  </LinearGradient>
                ) : (
                  <View style={styles.ctaCircleOnline}>
                    <Ionicons name="power" size={24} color="#ef4444" />
                  </View>
                )}
              </Pressable>
            </Animated.View>

            <RNText style={[styles.ctaLabel, isOnline && styles.ctaLabelOnline]}>
              {toggling
                ? (isOnline ? t('home.disconnecting', { defaultValue: 'DESCONECTANDO...' }) : t('home.connecting', { defaultValue: 'CONECTANDO...' }))
                : (isOnline ? t('home.go_offline').toUpperCase() : t('home.go_online').toUpperCase())
              }
            </RNText>
          </View>

          {/* Break toggle (visible when online) */}
          {isOnline && (
            <Pressable
              style={({ pressed }) => [
                styles.breakBtn,
                isOnBreak ? styles.breakBtnActive : styles.breakBtnInactive,
                togglingBreak && styles.toggleBtnDisabled,
                pressed && { opacity: 0.85 },
              ]}
              onPress={handleToggleBreak}
              disabled={togglingBreak}
            >
              <Ionicons
                name={isOnBreak ? 'arrow-forward-outline' : 'cafe-outline'}
                size={16}
                color={isOnBreak ? '#fff' : '#9ca3af'}
                style={{ marginRight: 6 }}
              />
              <RNText style={[styles.breakBtnText, isOnBreak && { color: '#fff' }]}>
                {isOnBreak ? t('home.end_break', { defaultValue: 'Terminar descanso' }) : t('home.start_break', { defaultValue: 'Tomar descanso' })}
              </RNText>
            </Pressable>
          )}
        </LinearGradient>
      </View>

      {/* ── Layer 3: Incoming ride modal overlay ── */}
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
          style={{ width: 90, height: 24 }}
          resizeMode="contain"
        />
        <View style={styles.logoDivider} />
        <RNText style={styles.logoSub}>{t('common.driver_label', { defaultValue: 'conductor' })}</RNText>
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
          <RNText style={[styles.statusPillText, { color: isOnline ? '#4ade80' : '#9ca3af' }]}>
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
  offlineDimOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },

  // ── Header ──
  tripHeaderGradient: {
    paddingHorizontal: 16,
    paddingBottom: 20,
  },
  floatingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  logoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(14,14,26,0.9)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
    gap: 0,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  logoTrici: {
    fontSize: 20,
    fontWeight: '800',
    color: '#fff',
    fontFamily: 'Montserrat',
    letterSpacing: -0.5,
  },
  logoGo: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.brand.orange,
    fontFamily: 'Montserrat',
    letterSpacing: -0.5,
    marginRight: 6,
  },
  logoDivider: {
    width: 1,
    height: 14,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginHorizontal: 8,
    alignSelf: 'center',
  },
  logoSub: {
    fontSize: 11,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.4)',
    fontFamily: 'Montserrat',
    alignSelf: 'flex-end',
    marginBottom: 1,
  },
  headerActions: {
    flexDirection: 'row',
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
    fontFamily: 'Montserrat',
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
    fontFamily: 'Montserrat',
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
    fontFamily: 'Montserrat',
    lineHeight: 18,
  },
  alertLink: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Montserrat',
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
    fontFamily: 'Montserrat',
  },
  omegaBannerSub: {
    color: '#9ca3af',
    fontSize: 11,
    fontFamily: 'Montserrat',
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
    fontFamily: 'Montserrat',
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
    fontFamily: 'Montserrat',
    letterSpacing: 6,
    textTransform: 'uppercase',
  },
  greetingName: {
    fontSize: 42,
    fontWeight: '900',
    color: '#ffffff',
    fontFamily: 'Montserrat',
    letterSpacing: 4,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  greetingMotivation: {
    fontSize: 13,
    fontWeight: '400',
    color: 'rgba(255,255,255,0.4)',
    fontFamily: 'Montserrat',
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
    fontFamily: 'Montserrat',
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
    fontFamily: 'Montserrat',
    fontWeight: '500',
    marginTop: 6,
    marginBottom: 3,
  },
  statCardValue: {
    fontSize: 20,
    color: '#fff',
    fontFamily: 'Montserrat',
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
    fontFamily: 'Montserrat',
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
    fontFamily: 'Montserrat',
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
    fontFamily: 'Montserrat',
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
