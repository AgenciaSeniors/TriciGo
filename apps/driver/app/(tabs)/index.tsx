import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable, FlatList, Image } from 'react-native';
import Toast from 'react-native-toast-message';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { driverService, getSupabaseClient, useFeatureFlag, notificationService } from '@tricigo/api';
import { HAVANA_CENTER, trackEvent } from '@tricigo/utils';
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
import { useDemandHeatmap } from '@/hooks/useDemandHeatmap';
import { useSelfieCheck } from '@/hooks/useSelfieCheck';
import { RideMapView } from '@/components/RideMapView';
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
  const notifCenterEnabled = useFeatureFlag('notification_center_enabled');
  const setUnreadCount = useNotificationStore((s) => s.setUnreadCount);
  const incrementUnread = useNotificationStore((s) => s.incrementUnread);
  const [serviceConfigs, setServiceConfigs] = useState<Record<string, { base_fare_cup: number; per_km_rate_cup: number; per_minute_rate_cup: number; min_fare_cup: number }>>({});

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

  // Check financial eligibility on mount and when profile changes
  useEffect(() => {
    if (!profile?.id) return;
    driverService.getEligibilityStatus(profile.id).then((status) => {
      setIsIneligible(!status.is_eligible);
    }).catch((err) => console.warn('[Driver] Failed to check eligibility:', err));
  }, [profile?.id]);

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

  const handleToggleOnline = useCallback(async () => {
    if (!profile || toggling) return; // Bug 38: Prevent rapid toggle
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

  // Active trip view
  if (activeTrip) {
    return (
      <Screen bg="dark" statusBarStyle="light-content" padded>
        <View className="pt-4 flex-1">
          <Header isOnline={isOnline} />
          <DriverTripView />
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded>
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
                data={incomingRequests}
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
              <View className="flex-1 items-center justify-center">
                <Text variant="body" color="inverse" className="opacity-30">
                  {t('home.waiting_requests')}
                </Text>
              </View>
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
