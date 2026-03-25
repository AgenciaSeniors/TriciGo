import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, FlatList, Image, Animated } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { driverService, getSupabaseClient, useFeatureFlag, notificationService } from '@tricigo/api';
import { HAVANA_CENTER, trackEvent, trackValidationEvent, haversineDistance, logger, getErrorMessage } from '@tricigo/utils';
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
import { useSelfieCheck } from '@/hooks/useSelfieCheck';
import { RideMapView } from '@/components/RideMapView';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@tricigo/theme';
import { Platform } from 'react-native';
import type { Ride } from '@tricigo/types';

// TEMP: Static web version for Play Store screenshots (all inline styles to bypass NativeWind web issues)
function WebDriverHomeScreen() {
  const font = { fontFamily: 'Montserrat, system-ui, sans-serif' };
  return (
    <View style={{ flex: 1, backgroundColor: '#111111', paddingHorizontal: 16 }}>
      <View style={{ paddingTop: 16, flex: 1 }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <Text style={{ fontSize: 24, fontWeight: '700', color: '#fff', ...font }}>Conductor</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(34,197,94,0.2)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#22c55e' }} />
            <Text style={{ fontSize: 14, color: '#4ade80', fontWeight: '600', ...font }}>En línea</Text>
          </View>
        </View>

        {/* Real Mapbox dark map of Havana */}
        <View style={{ height: 200, borderRadius: 16, overflow: 'hidden', position: 'relative', marginBottom: 12 }}>
          <Image
            source={require('../../assets/screenshots/map-havana-dark.png')}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
          {/* Driver location (pulsing blue dot) overlay */}
          <View style={{ position: 'absolute', top: 80, left: 170 }}>
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(30,136,229,0.25)', alignItems: 'center', justifyContent: 'center' }}>
              <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: '#1e88e5', borderWidth: 3, borderColor: '#fff' }} />
            </View>
          </View>
          {/* Demand heatmap zones */}
          <View style={{ position: 'absolute', top: 25, left: 70, width: 60, height: 50, borderRadius: 25, backgroundColor: 'rgba(249,115,22,0.15)' }} />
          <View style={{ position: 'absolute', top: 110, left: 260, width: 80, height: 55, borderRadius: 30, backgroundColor: 'rgba(249,115,22,0.2)' }} />
          <View style={{ position: 'absolute', top: 45, left: 300, width: 50, height: 40, borderRadius: 20, backgroundColor: 'rgba(249,115,22,0.1)' }} />
          {/* Demand indicator */}
          <View style={{ position: 'absolute', top: 8, right: 12, backgroundColor: 'rgba(249,115,22,0.2)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Ionicons name="flame" size={12} color={colors.brand.orange} />
            <Text style={{ color: colors.brand.orange, fontSize: 11, fontWeight: '600', ...font }}>Alta demanda</Text>
          </View>
        </View>

        {/* Today's earnings summary */}
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

        {/* Incoming request */}
        <Text style={{ fontSize: 18, fontWeight: '700', color: '#fff', marginBottom: 12, ...font }}>Solicitud entrante</Text>

        <View style={{ backgroundColor: '#1f1f1f', borderRadius: 12, padding: 16, marginBottom: 12 }}>
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
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, borderTopWidth: 1, borderTopColor: '#374151' }}>
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
    </View>
  );
}

function NativeDriverHomeScreen() {
  const { t } = useTranslation('driver');
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

  // Fix 5: Pulsing "searching" signal during idle
  const searchPulseAnim = useRef(new Animated.Value(1)).current;

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
        logger.warn('[Heartbeat] Failed', {
          driver_id: profile.id,
          error: getErrorMessage(err),
          consecutive_failures: heartbeatFailCountRef.current
        });
      }
    };

    // Immediate first heartbeat
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
      Animated.timing(tripFadeAnim, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }).start(() => {
        Animated.timing(tripFadeAnim, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }).start();
      });
    }
  }, [activeTrip, tripFadeAnim]);

  // Fix 5: Pulsing search animation when idle
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

  // DE-1.2: Auto-launch preferred navigation when ride is accepted
  useEffect(() => {
    if (!activeTrip || activeTrip.status !== 'accepted') return;
    const target = activeTrip.pickup_location;
    if (!target) return;

    if (preferredNav === 'external') {
      openNavigation(target.latitude, target.longitude);
    }
    // In-app nav is handled by DriverTripView component
  }, [activeTrip?.id, activeTrip?.status]);

  // Check financial eligibility on mount and every 60s while online
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

  // Demand heatmap data (refreshes every 5 min when online)
  const heatmapData = useDemandHeatmap(isOnline);

  // Selfie verification check
  const { needsCheck, isProcessing, loading: selfieLoading, submitSelfie, check: selfieCheck } = useSelfieCheck();

  const { acceptRide } = useDriverRideActions();

  // DE-1.3: Driver location for profitability calculation
  const driverLat = useLocationStore((s) => s.latitude);
  const driverLng = useLocationStore((s) => s.longitude);

  // DE-2.3: Track idle time and find nearest hot zone for demand nudge
  useEffect(() => {
    if (!isOnline || activeTrip || incomingRequests.length > 0 || isOnBreak) {
      setIdleSince(null);
      setIdleMinutes(0);
      setNearestHotZone(null);
      navCancelledRef.current = false; // Reset cancel flag for next ride cycle
      return;
    }

    if (!idleSince) {
      setIdleSince(Date.now());
    }

    const interval = setInterval(() => {
      if (idleSince) {
        const mins = Math.floor((Date.now() - idleSince) / 60000);
        setIdleMinutes(mins);

        // Find nearest hot zone after 10 min
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

          if (hotZones.length > 0 && hotZones[0]) {
            setNearestHotZone(hotZones[0]);
          }
        }
      }
    }, 60000); // Check every minute

    return () => clearInterval(interval);
  }, [isOnline, activeTrip, incomingRequests.length, isOnBreak, idleSince, heatmapData, driverLat, driverLng]);

  // OMEGA: Trigger auto-nav countdown when idle >= 10 min and hot zone found
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
        // Auto-navigate!
        trackValidationEvent('driver_auto_nav_triggered', {
          zone_distance: nearestHotZone?.distance,
          idle_minutes: idleMinutes,
        });
        openNavigation(nearestHotZone!.lat, nearestHotZone!.lng);
        setNavCountdown(null);
        setIdleSince(Date.now()); // Reset idle timer
      } else {
        setNavCountdown(navCountdown - 1);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [navCountdown]);

  const cancelAutoNav = useCallback(() => {
    trackValidationEvent('driver_auto_nav_cancelled', {
      zone_distance: nearestHotZone?.distance,
      idle_minutes: idleMinutes,
    });
    setNavCountdown(null);
    navCancelledRef.current = true; // Don't retry until next ride cycle
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
      const now = Date.now();
      setOnlineSince(now);
      // Also try to load from AsyncStorage
      AsyncStorage.getItem('driver_online_since').then(val => {
        if (val) {
          const parsed = parseInt(val, 10);
          if (!isNaN(parsed) && parsed > 0) setOnlineSince(parsed);
        }
      }).catch(() => {});
    } else if (isOnline && onlineSince) {
      AsyncStorage.setItem('driver_online_since', String(onlineSince)).catch(() => {});
    } else if (!isOnline) {
      setOnlineSince(null);
      AsyncStorage.removeItem('driver_online_since').catch(() => {});
    }
  }, [isOnline]);

  const hoursOnline = onlineSince ? Math.max((Date.now() - onlineSince) / 3600000, 0.1) : 0;
  const perHour = hoursOnline >= 0.5 ? Math.round(todayEarnings.amount / hoursOnline) : 0;

  const handleToggleOnline = useCallback(async () => {
    if (!profile || toggling) return; // Bug 38: Prevent rapid toggle
    // HF-3: Check GPS permission before going online
    if (!isOnline) {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') {
        Toast.show({ type: 'error', text1: t('home.location_required') });
        logger.warn('[GPS] Permission denied, blocking online');
        return;
      }
    }
    // Bug 12: Block going offline during active ride
    if (isOnline && activeTrip) {
      Toast.show({ type: 'error', text1: t('driver.cannot_offline_active_ride', { defaultValue: 'No puedes desconectarte durante un viaje activo' }) });
      return;
    }
    setToggling(true);
    try {
      const newStatus = !isOnline;
      await driverService.setOnlineStatus(
        profile.id,
        newStatus,
        newStatus ? HAVANA_CENTER : undefined,
      );
      setOnline(newStatus);
      trackEvent(newStatus ? 'driver_went_online' : 'driver_went_offline');
    } catch {
      Toast.show({ type: 'error', text1: t('common.status_change_failed') });
    } finally {
      setToggling(false);
    }
  }, [profile, isOnline, setOnline]);

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

  const handleAccept = useCallback(
    (rideId: string) => {
      acceptRide(rideId);
    },
    [acceptRide],
  );

  const handleReject = useCallback(
    (rideId: string) => {
      removeRequest(rideId);
    },
    [removeRequest],
  );

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

  // DT-2: Active trip view wrapped in crossfade
  if (activeTrip) {
    return (
      <Screen bg="dark" statusBarStyle="light-content" padded>
        <Animated.View style={{ opacity: tripFadeAnim, flex: 1 }}>
          <View className="pt-4 flex-1">
            <Header isOnline={isOnline} />
            <DriverTripView />
          </View>
        </Animated.View>
      </Screen>
    );
  }

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded>
      <Animated.View style={{ opacity: tripFadeAnim, flex: 1 }}>
      <View className="pt-4 flex-1">
        <Header isOnline={isOnline} />

        {/* Ineligibility banner */}
        {isIneligible && (
          <View className="bg-red-900/80 rounded-xl p-4 mb-4" accessibilityRole="alert" accessibilityLiveRegion="polite">
            <Text variant="bodySmall" color="inverse" className="mb-2">
              {t('home.ineligible_banner')}
            </Text>
            <Button
              title={t('home.ineligible_recharge')}
              variant="outline"
              size="sm"
              onPress={() => router.push('/(tabs)/earnings')}
            />
          </View>
        )}

        {/* Selfie verification banner */}
        {(needsCheck || isProcessing) && (
          <View className="bg-amber-900/80 rounded-xl p-4 mb-4" accessibilityRole="alert" accessibilityLiveRegion="polite">
            <View className="flex-row items-center mb-2">
              <Ionicons name="camera-outline" size={20} color={colors.warning.DEFAULT} />
              <Text variant="bodySmall" color="inverse" className="ml-2 font-semibold">
                {t('verification.selfie_required')}
              </Text>
            </View>
            {isProcessing ? (
              <Text variant="caption" color="inverse" className="opacity-70">
                {t('verification.processing')}
              </Text>
            ) : selfieCheck?.status === 'failed' ? (
              <>
                <Text variant="caption" color="inverse" className="opacity-70 mb-2">
                  {t('verification.failed')}
                </Text>
                <Button
                  title={t('verification.take_selfie')}
                  variant="outline"
                  size="sm"
                  onPress={submitSelfie}
                  loading={selfieLoading}
                />
              </>
            ) : (
              <>
                <Text variant="caption" color="inverse" className="opacity-70 mb-2">
                  {t('verification.selfie_desc')}
                </Text>
                <Button
                  title={t('verification.take_selfie')}
                  variant="outline"
                  size="sm"
                  onPress={submitSelfie}
                  loading={selfieLoading}
                />
              </>
            )}
          </View>
        )}

        {/* DT-2: Today's earnings card */}
        {isOnline && (
          <View style={{
            backgroundColor: '#1F2937',
            borderRadius: 12,
            padding: 12,
            marginBottom: 12,
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <Text style={{ fontSize: 14, color: '#22C55E', fontWeight: '700' }}>
              {t('home.today_earnings', {
                amount: `\u20A7${todayEarnings.amount.toLocaleString()}`,
                count: todayEarnings.trips,
              })}
              {perHour > 0 ? ` · ${t('home.per_hour', { amount: perHour.toLocaleString() })}` : ''}
            </Text>
          </View>
        )}

        {/* Online/Offline toggle */}
        <Pressable
          className={`
            w-full py-5 rounded-2xl items-center justify-center mb-6
            ${isOnline ? 'bg-error' : 'bg-primary-500'}
            ${toggling ? 'opacity-50' : ''}
          `}
          onPress={handleToggleOnline}
          disabled={toggling}
          accessibilityRole="switch"
          accessibilityState={{ checked: isOnline, disabled: toggling }}
          accessibilityLabel={isOnline ? t('home.go_offline') : t('home.go_online')}
          accessibilityHint={t('a11y.toggles_online_status', { ns: 'common' })}
        >
          <Text variant="h4" color="inverse">
            {isOnline ? t('home.go_offline') : t('home.go_online')}
          </Text>
        </Pressable>

        {/* Break mode toggle (only visible when online) */}
        {isOnline && (
          <View className="mb-4">
            {isOnBreak && (
              <View className="bg-amber-500/20 rounded-xl px-4 py-2 mb-2 flex-row items-center justify-center" accessibilityRole="alert">
                <Ionicons name="cafe-outline" size={16} color="#f59e0b" />
                <Text variant="bodySmall" className="ml-2 text-amber-400 font-semibold">
                  {t('home.on_break_label', { defaultValue: 'En descanso — no recibes solicitudes' })}
                </Text>
              </View>
            )}
            <Pressable
              className={`
                w-full py-3 rounded-xl items-center justify-center
                ${isOnBreak ? 'bg-primary-500' : 'bg-amber-600'}
                ${togglingBreak ? 'opacity-50' : ''}
              `}
              onPress={handleToggleBreak}
              disabled={togglingBreak}
              accessibilityRole="button"
              accessibilityState={{ disabled: togglingBreak }}
              accessibilityLabel={isOnBreak
                ? t('home.end_break', { defaultValue: 'Volver' })
                : t('home.start_break', { defaultValue: 'En descanso' })}
            >
              <View className="flex-row items-center gap-2">
                <Ionicons
                  name={isOnBreak ? 'arrow-back-outline' : 'cafe-outline'}
                  size={18}
                  color="#fff"
                />
                <Text variant="body" color="inverse" className="font-semibold">
                  {isOnBreak
                    ? t('home.end_break', { defaultValue: 'Volver' })
                    : t('home.start_break', { defaultValue: 'En descanso' })}
                </Text>
              </View>
            </Pressable>
          </View>
        )}

        {/* Auto-accept is now handled inside IncomingRideCard (OMEGA) */}

        {/* Content based on online state */}
        {isOnline ? (
          incomingRequests.length > 0 ? (
            <View className="flex-1">
              <Text variant="label" color="inverse" className="mb-3 opacity-70" accessibilityLiveRegion="polite" accessibilityLabel={t('a11y.incoming_requests', { ns: 'common', count: incomingRequests.length })}>
                {t('home.incoming_rides', { defaultValue: 'Solicitudes disponibles' })}
                {' '}({incomingRequests.length})
              </Text>
              {heatmapData.length > 0 && (
                <RideMapView heatmapData={heatmapData} height={150} />
              )}
              <FlatList
                data={incomingRequests.length > 1 ? incomingRequests.slice(1) : []}
                renderItem={renderRequest}
                keyExtractor={(item) => item.id}
                showsVerticalScrollIndicator={false}
              />
            </View>
          ) : (
            <View className="flex-1">
              {heatmapData.length > 0 && (
                <RideMapView heatmapData={heatmapData} height={200} />
              )}
              {/* OMEGA: Auto-navigation countdown to hot zone */}
              {navCountdown !== null && nearestHotZone && (
                <View style={{ backgroundColor: '#1F2937', borderRadius: 12, padding: 12, marginTop: 12, borderColor: '#F59E0B', borderWidth: 1 }}>
                  <Text style={{ color: '#F59E0B', fontSize: 14, fontWeight: '600', marginBottom: 4 }}>
                    {t('home.high_demand_zone', { seconds: navCountdown, defaultValue: 'Navegando a zona con alta demanda en {{seconds}}s' })}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ color: '#9CA3AF', fontSize: 12 }}>
                      {t('home.active_zone_nearby', { distance: nearestHotZone.distance })}
                    </Text>
                    <Pressable
                      style={{ backgroundColor: '#374151', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 }}
                      onPress={cancelAutoNav}
                    >
                      <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>
                        {t('home.stay_here', { defaultValue: 'Quedarme aquí' })}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              )}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 24, marginBottom: 8 }}>
                <Animated.View style={{
                  width: 8, height: 8, borderRadius: 4, backgroundColor: '#22C55E',
                  opacity: searchPulseAnim, marginRight: 8,
                }} />
                <Text style={{ color: '#9CA3AF', fontSize: 14 }}>
                  {t('home.searching_rides', { defaultValue: 'Buscando viajes cerca de ti...' })}
                </Text>
              </View>
              {/* OMEGA: Wait time estimate */}
              {estimatedWaitMinutes && (
                <Text style={{ color: '#9CA3AF', fontSize: 12, marginTop: 4, textAlign: 'center' }}>
                  {t('home.next_ride_estimated', { minutes: estimatedWaitMinutes })}
                </Text>
              )}
            </View>
          )
        ) : (
          <View className="flex-1 items-center justify-center">
            <Text variant="body" color="inverse" className="opacity-30">
              {t('home.offline')}
            </Text>
          </View>
        )}
      </View>

      {/* DT-2: First ride as modal overlay */}
      {incomingRequests.length > 0 && !activeTrip && (() => {
        const firstRide = incomingRequests[0]!;
        return (
          <View style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.7)',
            zIndex: 100,
            justifyContent: 'center',
            paddingHorizontal: 16,
          }}>
            <IncomingRideCard
              ride={firstRide}
              onAccept={() => handleAccept(firstRide.id)}
              onReject={() => handleReject(firstRide.id)}
              driverCustomRateCup={profile?.custom_per_km_rate_cup ?? null}
              serviceConfig={serviceConfigs[firstRide.service_type] ?? null}
            />
          </View>
        );
      })()}
      </Animated.View>
    </Screen>
  );
}

function Header({ isOnline }: { isOnline: boolean }) {
  const { t } = useTranslation('driver');
  const notifCenterEnabled = useFeatureFlag('notification_center_enabled');
  const unreadCount = useNotificationStore((s) => s.unreadCount);

  return (
    <View className="flex-row items-center justify-between mb-6">
      <View>
        <Text variant="h3" color="inverse">
          Trici<Text variant="h3" color="accent">Go</Text>
        </Text>
        <Text variant="caption" color="inverse" className="opacity-50">
          {t('common.driver_label')}
        </Text>
      </View>
      <View className="flex-row items-center gap-3">
        {notifCenterEnabled && (
          <Pressable
            onPress={() => router.push('/notifications')}
            className="relative p-1"
            accessibilityRole="button"
            accessibilityLabel={unreadCount > 0 ? `${t('notifications.title')}, ${t('a11y.unread_count', { ns: 'common', count: unreadCount })}` : t('notifications.title')}
          >
            <Ionicons
              name={unreadCount > 0 ? 'notifications' : 'notifications-outline'}
              size={22}
              color={colors.neutral[400]}
            />
            {unreadCount > 0 && (
              <View className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 rounded-full bg-red-500 items-center justify-center px-1">
                <Text variant="caption" className="text-white text-[10px] font-bold">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </Text>
              </View>
            )}
          </Pressable>
        )}
        <View
          className={`px-3 py-1.5 rounded-full ${
            isOnline ? 'bg-success' : 'bg-neutral-700'
          }`}
          accessible={true}
          accessibilityLabel={isOnline ? t('home.online') : t('home.offline')}
        >
          <Text variant="caption" color="inverse">
            {isOnline ? t('home.online') : t('home.offline')}
          </Text>
        </View>
      </View>
    </View>
  );
}

export default function DriverHomeScreen() {
  if (Platform.OS === 'web') return <WebDriverHomeScreen />;
  return <NativeDriverHomeScreen />;
}
