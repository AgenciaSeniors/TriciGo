import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { View, Pressable, ActivityIndicator, Platform, Switch, Image } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { ServiceTypeCard } from '@tricigo/ui/ServiceTypeCard';
import { formatTRC, triggerSelection, triggerHaptic, suggestPickupPoint, logger } from '@tricigo/utils';
import * as Location from 'expo-location';
import { useTranslation } from '@tricigo/i18n';
import { walletService, customerService, useFeatureFlag, notificationService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { useNotificationStore } from '@/stores/notification.store';
import { useRideInit, useRideActions } from '@/hooks/useRide';
import { useRoutePolyline } from '@/hooks/useRoutePolyline';
import { WebMapView } from '@/components/WebMapView';
import { useNearbyVehicles } from '@/hooks/useNearbyVehicles';
import { RideActiveView } from '@/components/RideActiveView';
import { RideCompleteView } from '@/components/RideCompleteView';
import { RideMapView } from '@/components/RideMapView';
import { AddressSearchInput } from '@/components/AddressSearchInput';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';
import { RouteSummary } from '@tricigo/ui/RouteSummary';
import { Skeleton, SkeletonCard } from '@tricigo/ui/Skeleton';
import { FareBreakdownCard } from '@tricigo/ui/FareBreakdownCard';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { colors } from '@tricigo/theme';
import { Ionicons } from '@expo/vector-icons';
import { useRecentAddresses } from '@/hooks/useRecentAddresses';
import { useDestinationPredictions } from '@/hooks/useDestinationPredictions';
import { vehicleSelectionImages } from '@/utils/vehicleImages';
import { SplitInviteCard } from '@/components/SplitInviteCard';
import { FareSplitSheet } from '@/components/FareSplitSheet';
import type { SavedLocation, ServiceTypeSlug, CorporateAccount } from '@tricigo/types';
import type { PredictedDestination } from '@tricigo/utils';
import { useCorporateAccounts } from '@/hooks/useCorporateAccounts';
import { NotificationPermissionSheet } from '@/components/NotificationPermissionSheet';
import { OnboardingOverlay } from '@/components/OnboardingOverlay';
import { useRiderLocationSharing } from '@/hooks/useRiderLocationSharing';
// Surge is calculated backend-side but not shown to users
// import { useSurgeZones } from '@/hooks/useSurgeZones';

// Coin icon for BalanceBadge
const tricoinSmall = require('../../assets/coins/tricoin-small.png');

function useDebouncePress(callback: (...args: any[]) => void, delayMs = 1000) {
  const lastPress = useRef(0);
  return useCallback((...args: any[]) => {
    const now = Date.now();
    if (now - lastPress.current < delayMs) return;
    lastPress.current = now;
    callback(...args);
  }, [callback, delayMs]);
}

// Web version of home screen — uses real data from stores
function WebHomeScreen() {
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const font = { fontFamily: 'Montserrat, system-ui, sans-serif' };

  const [balance, setBalance] = useState(0);
  useEffect(() => {
    if (!user?.id) return;
    walletService.getBalance(user.id).then((b) => setBalance(b.available)).catch(() => {});
  }, [user?.id]);

  const firstName = user?.full_name?.split(' ')[0] ?? '';
  const services = [
    { name: 'Moto', slug: 'moto_standard', img: require('../../assets/vehicles/selection/moto.png') },
    { name: 'Triciclo', slug: 'triciclo_basico', img: require('../../assets/vehicles/selection/triciclo.png') },
    { name: 'Auto', slug: 'auto_standard', img: require('../../assets/vehicles/selection/auto.png') },
    { name: 'Confort', slug: 'auto_confort', img: require('../../assets/vehicles/selection/confort.png') },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: '#111111' }}>
      {/* Map background — full height */}
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
        <WebMapView center={[-82.38, 23.13]} zoom={14} interactive={true} />
      </View>

      {/* Overlay UI */}
      <View style={{ flex: 1, justifyContent: 'space-between' }}>
        {/* Top section */}
        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <Text style={{ fontSize: 24, fontWeight: '700', color: '#fff', ...font }}>
              {firstName ? `¡Hola, ${firstName}!` : t('home.greeting', { defaultValue: 'Bienvenido' })}
            </Text>
            <Pressable onPress={() => router.push('/notifications')} style={{ position: 'relative', padding: 8 }}>
              <Ionicons name="notifications" size={24} color="#fff" />
              {unreadCount > 0 && (
                <View style={{ position: 'absolute', top: 4, right: 4, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: '#ef4444', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}>
                  <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700', ...font }}>{unreadCount}</Text>
                </View>
              )}
            </Pressable>
          </View>

          {/* Balance badge */}
          <View style={{ backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, marginBottom: 12, backdropFilter: 'blur(10px)' } as any}>
            <Text style={{ fontSize: 16, fontWeight: '600', color: '#fff', ...font }}>
              T$ {(balance / 100).toFixed(2)}
            </Text>
          </View>

          {/* Search bar */}
          <Pressable style={{ backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, elevation: 4 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.brand.orange, marginRight: 12 }} />
            <Text style={{ fontSize: 16, color: '#9ca3af', ...font }}>{t('ride.where_to', { defaultValue: '¿A dónde vas?' })}</Text>
          </Pressable>
        </View>

        {/* Bottom section — services */}
        <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
          {/* Service type cards */}
          <View style={{ backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 16, padding: 16, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 12, elevation: 4 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 12, ...font }}>
              {t('ride.select_service', { defaultValue: 'Servicios' })}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {services.map((svc, i) => (
                <View key={svc.slug} style={{
                  flex: 1, borderRadius: 12, padding: 10, alignItems: 'center',
                  backgroundColor: i === 1 ? '#FFF7ED' : '#fafafa',
                  borderWidth: i === 1 ? 2 : 0,
                  borderColor: i === 1 ? colors.brand.orange : 'transparent',
                }}>
                  <Image source={svc.img} style={{ width: 44, height: 44 }} resizeMode="contain" />
                  <Text style={{ marginTop: 4, fontSize: 11, fontWeight: i === 1 ? '700' : '500', color: i === 1 ? colors.brand.orange : '#6b7280', ...font }}>
                    {svc.name}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

function NativeHomeScreen() {
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);

  // Init ride state from DB
  useRideInit();

  // Share rider location during pickup phase (G1)
  useRiderLocationSharing();

  const flowStep = useRideStore((s) => s.flowStep);

  // Onboarding overlay — shows once on first app launch
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem('@tricigo/onboarding_completed').then((v) => {
      if (!v) setShowOnboarding(true);
    });
  }, []);

  return (
    <Screen bg="white" padded scroll>
      {flowStep === 'idle' && <IdleView />}
      {flowStep === 'selecting' && <SelectingView />}
      {flowStep === 'reviewing' && <ReviewingView />}
      {flowStep === 'searching' && <SearchingView />}
      {flowStep === 'active' && <RideActiveView />}
      {flowStep === 'completed' && <RideCompleteView />}
      {/* Notification permission prompt (shows once on first visit) */}
      {flowStep === 'idle' && <NotificationPermissionSheet />}
      {/* Onboarding tutorial (shows once on first app launch) */}
      {showOnboarding && (
        <OnboardingOverlay
          onComplete={() => {
            setShowOnboarding(false);
            AsyncStorage.setItem('@tricigo/onboarding_completed', 'true');
          }}
        />
      )}
    </Screen>
  );
}

// ── Idle View ──────────────────────────────────────────────

function IdleView() {
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);
  const setFlowStep = useRideStore((s) => s.setFlowStep);
  const setDropoff = useRideStore((s) => s.setDropoff);
  const [locationDenied, setLocationDenied] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [walletBalance, setWalletBalance] = useState(0);
  const { recentAddresses } = useRecentAddresses();
  const { predictions } = useDestinationPredictions();
  // Surge is calculated in the backend but not shown to users
  // const { hasActiveSurge, maxMultiplier } = useSurgeZones();
  const notifCenterEnabled = useFeatureFlag('notification_center_enabled');
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const setUnreadCount = useNotificationStore((s) => s.setUnreadCount);
  const incrementUnread = useNotificationStore((s) => s.incrementUnread);

  // Check location permission on mount
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted') setLocationDenied(true);
      } catch {
        // Silently ignore — don't crash
      }
    })();
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        await walletService.ensureAccount(user.id);
        const bal = await walletService.getBalance(user.id);
        if (!cancelled) setWalletBalance(bal.available);
      } catch (err) { logger.warn('Failed to load wallet', { error: String(err) }); }
      if (!cancelled) setInitialLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // Fallback timeout for loading state
  useEffect(() => {
    const timer = setTimeout(() => setInitialLoading(false), 3000);
    return () => clearTimeout(timer);
  }, []);

  // Fetch unread count + subscribe to realtime notifications
  useEffect(() => {
    if (!user?.id || !notifCenterEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const count = await notificationService.getUnreadCount(user.id);
        if (!cancelled) setUnreadCount(count);
      } catch (err) { logger.warn('Failed to load unread count', { error: String(err) }); }
    })();
    const subscription = notificationService.subscribeToNotifications(user.id, () => {
      if (!cancelled) incrementUnread();
    });
    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [user?.id, notifCenterEnabled]);

  const handleRecentTap = useCallback((addr: { address: string; latitude: number; longitude: number }) => {
    setDropoff(addr.address, { latitude: addr.latitude, longitude: addr.longitude });
    setFlowStep('selecting');
  }, [setDropoff, setFlowStep]);

  if (initialLoading) {
    return (
      <View className="pt-4">
        <Skeleton width="60%" height={28} className="mb-4" />
        <Skeleton width="40%" height={20} className="mb-6" />
        <SkeletonCard className="mb-4" />
        <Skeleton width="100%" height={52} className="rounded-xl mb-4" />
        <SkeletonCard className="mb-4" />
      </View>
    );
  }

  return (
    <View className="pt-4">
      {/* Location permission denied banner */}
      {locationDenied && (
        <Pressable
          onPress={async () => {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status === 'granted') setLocationDenied(false);
          }}
          className="bg-yellow-50 border border-yellow-200 rounded-xl px-4 py-3 mb-4 flex-row items-center"
        >
          <Ionicons name="location-outline" size={20} color="#D97706" />
          <View className="flex-1 ml-3">
            <Text variant="bodySmall" className="font-semibold text-yellow-800">
              {t('home.location_denied_title', { defaultValue: 'Ubicación desactivada' })}
            </Text>
            <Text variant="caption" className="text-yellow-700">
              {t('home.location_denied_msg', { defaultValue: 'Activa la ubicación para encontrar conductores cercanos.' })}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color="#D97706" />
        </Pressable>
      )}

      <View className="flex-row items-center justify-between mb-1">
        <Text variant="h3">
          {t('home.greeting', { name: user?.full_name ?? 'Viajero' })}
        </Text>
        {notifCenterEnabled && (
          <Pressable
            onPress={() => router.push('/notifications')}
            className="relative p-2"
            accessibilityRole="button"
            accessibilityLabel={unreadCount > 0 ? `${t('notifications.title')}, ${t('a11y.unread_count', { ns: 'common', count: unreadCount })}` : t('notifications.title')}
          >
            <Ionicons
              name={unreadCount > 0 ? 'notifications' : 'notifications-outline'}
              size={24}
              color={colors.neutral[700]}
            />
            {unreadCount > 0 && (
              <View className="absolute top-1 right-1 min-w-[16px] h-4 rounded-full bg-red-500 items-center justify-center px-1">
                <Text variant="caption" className="text-white text-[10px] font-bold">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </Text>
              </View>
            )}
          </Pressable>
        )}
      </View>

      <BalanceBadge balance={walletBalance} size="sm" coinIcon={tricoinSmall} className="mt-4 mb-6" />

      {/* Pending split invites */}
      <SplitInviteCard />

      {/* Destination search */}
      <Pressable
        className="bg-neutral-100 rounded-xl px-4 py-4 flex-row items-center mb-4"
        onPress={() => setFlowStep('selecting')}
        accessibilityRole="search"
        accessibilityLabel={t('home.where_to')}
        accessibilityHint={t('a11y.opens_destination', { ns: 'common' })}
      >
        <View className="w-3 h-3 rounded-full bg-primary-500 mr-3" />
        <Text variant="body" color="tertiary">
          {t('home.where_to')}
        </Text>
      </Pressable>

      {/* Predicted destinations */}
      {predictions.length > 0 && (
        <View className="mb-4">
          <Text variant="caption" color="secondary" className="mb-2">
            {t('prediction.suggested_for_you', { defaultValue: 'Sugerencias para ti' })}
          </Text>
          {predictions.slice(0, 3).map((pred, idx) => (
            <Pressable
              key={`pred-${idx}`}
              className="flex-row items-center bg-primary-50 rounded-xl px-4 py-3 mb-2"
              onPress={() => handleRecentTap({ address: pred.address, latitude: pred.latitude, longitude: pred.longitude })}
              accessibilityRole="button"
              accessibilityLabel={pred.address || pred.name}
            >
              <Ionicons
                name={pred.reason === 'time_pattern' ? 'time-outline' : pred.reason === 'frequent' ? 'star' : 'navigate-outline'}
                size={18}
                color={colors.brand.orange}
              />
              <View className="flex-1 ml-3">
                <Text variant="bodySmall" numberOfLines={1}>{pred.address}</Text>
                <Text variant="caption" color="accent">
                  {pred.reason === 'time_pattern'
                    ? t('prediction.time_pattern', { defaultValue: 'Según tu horario' })
                    : pred.reason === 'frequent'
                      ? t('prediction.frequent', { defaultValue: 'Destino frecuente' })
                      : t('prediction.recent', { defaultValue: 'Viaje reciente' })}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.neutral[400]} />
            </Pressable>
          ))}
        </View>
      )}

      {/* Recent places */}
      {recentAddresses.length > 0 && (
        <View className="mb-4">
          <Text variant="caption" color="secondary" className="mb-2">
            {t('home.recent_places', { defaultValue: 'Lugares recientes' })}
          </Text>
          {recentAddresses.slice(0, 3).map((addr, idx) => (
            <Pressable
              key={`recent-idle-${idx}`}
              className="flex-row items-center bg-neutral-50 rounded-xl px-4 py-3 mb-2"
              onPress={() => handleRecentTap(addr)}
              accessibilityRole="button"
              accessibilityLabel={addr.address}
            >
              <Ionicons name="time-outline" size={18} color={colors.neutral[500]} />
              <Text variant="bodySmall" className="flex-1 ml-3" numberOfLines={1}>
                {addr.address}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={colors.neutral[400]} />
            </Pressable>
          ))}
        </View>
      )}

      {/* Service types */}
      <Text variant="h4" className="mb-3">{t('home.services', { defaultValue: 'Servicios' })}</Text>
      <View className="flex-row gap-3" accessibilityRole="radiogroup">
        {(['moto_standard', 'triciclo_basico', 'auto_standard', 'auto_confort'] as const).map((slug) => (
          <ServiceTypeCard
            key={slug}
            slug={slug}
            name={t(`service_type.${slug}` as const)}
            icon={vehicleSelectionImages[slug]}
          />
        ))}
      </View>
    </View>
  );
}

// ── Selecting View ─────────────────────────────────────────

function SelectingView() {
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);
  const {
    draft,
    setPickup,
    setDropoff,
    setServiceType,
    setPaymentMethod,
    setScheduledAt,
    setDeliveryField,
    setPassengerCount,
    setCorporateAccount,
    setFlowStep,
    addWaypoint,
    removeWaypoint,
    updateWaypoint,
    isLoading,
    isFareEstimating,
    error,
  } = useRideStore();
  const { requestEstimate } = useRideActions();
  const { recentAddresses } = useRecentAddresses();
  const { predictions } = useDestinationPredictions();
  const { accounts: corporateAccounts } = useCorporateAccounts();
  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>([]);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [pickupSuggestion, setPickupSuggestion] = useState<{
    latitude: number; longitude: number; address: string;
  } | null>(null);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);

  // Predictive pickup: suggest a better pickup point near a road
  useEffect(() => {
    setSuggestionDismissed(false);
    setPickupSuggestion(null);
    const loc = draft.pickup?.location;
    if (!loc) return;
    let cancelled = false;
    suggestPickupPoint(loc.latitude, loc.longitude).then((suggestion) => {
      if (!cancelled && suggestion) setPickupSuggestion(suggestion);
    });
    return () => { cancelled = true; };
  }, [draft.pickup?.location?.latitude, draft.pickup?.location?.longitude]);

  // Bug 11: Re-estimate fare when payment method changes
  const prevPaymentRef = useRef(draft.paymentMethod);
  useEffect(() => {
    if (draft.paymentMethod !== prevPaymentRef.current) {
      prevPaymentRef.current = draft.paymentMethod;
      const fe = useRideStore.getState().fareEstimate;
      if (fe) requestEstimate();
    }
  }, [draft.paymentMethod, requestEstimate]);

  // Load saved locations from customer profile
  useEffect(() => {
    if (!user?.id) return;
    customerService.ensureProfile(user.id).then((cp) => {
      setSavedLocations(cp.saved_locations ?? []);
    }).catch(() => {});
  }, [user?.id]);

  const isDelivery = draft.serviceType === 'mensajeria';
  const deliveryValid = !isDelivery || (
    draft.delivery.packageDescription.trim() &&
    draft.delivery.recipientName.trim() &&
    draft.delivery.recipientPhone.trim()
  );
  const canEstimate = draft.pickup && draft.dropoff && deliveryValid;

  const minScheduleDate = new Date(Date.now() + 30 * 60 * 1000); // at least 30 min from now

  return (
    <View className="pt-4">
      <ScreenHeader title={t('ride.select_route', { defaultValue: 'Seleccionar ruta' })} onBack={() => setFlowStep('idle')} />

      {/* Pickup — address search with presets */}
      <Text variant="label" className="mb-1">
        {t('ride.pickup')}
      </Text>
      <AddressSearchInput
        placeholder={t('ride.enter_pickup', { defaultValue: 'Punto de recogida' })}
        selectedAddress={draft.pickup?.address ?? null}
        onSelect={(address, location) => setPickup(address, location)}
        savedLocations={savedLocations}
        recentAddresses={recentAddresses}
        showUseMyLocation
      />

      {/* Predictive pickup suggestion banner */}
      {pickupSuggestion && !suggestionDismissed && (
        <View className="bg-primary-50 border border-primary-200 rounded-xl px-4 py-3 mt-2">
          <View className="flex-row items-start">
            <Ionicons name="location" size={18} color={colors.brand.orange} style={{ marginTop: 2 }} />
            <View className="flex-1 ml-2">
              <Text variant="bodySmall" className="text-neutral-800">
                {t('ride.pickup_suggestion', { defaultValue: 'Punto de recogida sugerido' })}:{' '}
                <Text variant="bodySmall" className="font-semibold">{pickupSuggestion.address}</Text>
              </Text>
              <Text variant="caption" color="secondary" className="mt-0.5">
                {t('ride.pickup_suggestion_reason', { defaultValue: 'Los conductores te encontraran mas facilmente aqui' })}
              </Text>
              <View className="flex-row gap-3 mt-2">
                <Pressable
                  className="bg-primary-500 rounded-lg px-3 py-1.5"
                  onPress={() => {
                    setPickup(pickupSuggestion.address, {
                      latitude: pickupSuggestion.latitude,
                      longitude: pickupSuggestion.longitude,
                    });
                    setPickupSuggestion(null);
                    triggerSelection();
                  }}
                >
                  <Text variant="caption" color="inverse" className="font-semibold">
                    {t('ride.use_suggested', { defaultValue: 'Usar punto sugerido' })}
                  </Text>
                </Pressable>
                <Pressable
                  className="px-3 py-1.5"
                  onPress={() => setSuggestionDismissed(true)}
                >
                  <Text variant="caption" color="secondary">
                    {t('ride.keep_original', { defaultValue: 'Mantener original' })}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      )}

      <View className="h-2" />

      {/* Dropoff — address search with presets */}
      <Text variant="label" className="mb-1">
        {t('ride.dropoff')}
      </Text>
      <AddressSearchInput
        placeholder={t('ride.enter_dropoff', { defaultValue: 'Destino' })}
        selectedAddress={draft.dropoff?.address ?? null}
        onSelect={(address, location) => setDropoff(address, location)}
        savedLocations={savedLocations}
        recentAddresses={recentAddresses}
        predictions={predictions}
      />

      {/* Waypoints */}
      {draft.waypoints.map((wp, idx) => (
        <View key={`waypoint-${idx}`}>
          <View className="h-2" />
          <View className="flex-row items-center">
            <View className="flex-1">
              <Text variant="label" className="mb-1">
                {t('ride.stop_n', { n: idx + 1 })}
              </Text>
              <AddressSearchInput
                placeholder={t('ride.stop_n', { n: idx + 1 })}
                selectedAddress={wp.address || null}
                onSelect={(address, location) => updateWaypoint(idx, address, location)}
              />
            </View>
            <Pressable
              onPress={() => removeWaypoint(idx)}
              className="ml-2 mt-5 p-2"
              accessibilityRole="button"
              accessibilityLabel={t('ride.remove_stop', { defaultValue: `Remove stop ${idx + 1}`, n: idx + 1 })}
            >
              <Ionicons name="close-circle" size={24} color={colors.error.DEFAULT} />
            </Pressable>
          </View>
        </View>
      ))}

      {/* Add stop button */}
      {draft.waypoints.length < 3 && (
        <Pressable
          onPress={addWaypoint}
          className="flex-row items-center mt-2 mb-2 py-2"
          accessibilityRole="button"
          accessibilityLabel={t('ride.add_stop')}
        >
          <Ionicons name="add-circle-outline" size={20} color={colors.brand.orange} />
          <Text variant="bodySmall" color="accent" className="ml-2">
            {t('ride.add_stop')}
          </Text>
        </Pressable>
      )}

      <View className="h-4" />

      {/* Service type */}
      <Text variant="label" className="mb-2">{t('ride.service_label', { defaultValue: 'Servicio' })}</Text>
      <View className="flex-row flex-wrap gap-3 mb-4" accessibilityRole="radiogroup">
        {(['moto_standard', 'triciclo_basico', 'auto_standard', 'auto_confort'] as ServiceTypeSlug[]).map((slug) => (
          <View key={slug} style={{ width: '22%' }}>
            <ServiceTypeCard
              slug={slug}
              name={t(`service_type.${slug}` as const)}
              icon={vehicleSelectionImages[slug]}
              selected={draft.serviceType === slug || (slug === 'triciclo_basico' && draft.serviceType === 'triciclo_cargo')}
              onPress={() => { setServiceType(slug); triggerSelection(); }}
              compact
            />
          </View>
        ))}
      </View>

      {/* Triciclo mode toggle: Pasajero / Cargo */}
      {(draft.serviceType === 'triciclo_basico' || draft.serviceType === 'triciclo_cargo') && (
        <View className="flex-row gap-2 mb-4 bg-neutral-100 rounded-xl p-1">
          <Pressable
            className={`flex-1 py-2 rounded-lg items-center ${draft.serviceType === 'triciclo_basico' ? 'bg-white shadow-sm' : ''}`}
            onPress={() => setServiceType('triciclo_basico')}
          >
            <Text variant="bodySmall" className={draft.serviceType === 'triciclo_basico' ? 'font-semibold' : 'text-neutral-500'}>
              {t('ride.mode_passenger', { defaultValue: 'Pasajero' })}
            </Text>
          </Pressable>
          <Pressable
            className={`flex-1 py-2 rounded-lg items-center ${draft.serviceType === 'triciclo_cargo' ? 'bg-white shadow-sm' : ''}`}
            onPress={() => setServiceType('triciclo_cargo')}
          >
            <Text variant="bodySmall" className={draft.serviceType === 'triciclo_cargo' ? 'font-semibold' : 'text-neutral-500'}>
              {t('ride.mode_cargo', { defaultValue: 'Mercancia' })}
            </Text>
          </Pressable>
        </View>
      )}

      {/* Cargo info note */}
      {draft.serviceType === 'triciclo_cargo' && (
        <Card variant="outlined" padding="md" className="mb-4">
          <View className="flex-row items-center mb-2">
            <Ionicons name="cube-outline" size={20} color={colors.brand.orange} />
            <Text variant="label" className="ml-2">
              {t('ride.cargo_title', { defaultValue: 'Servicio de carga' })}
            </Text>
          </View>
          <Text variant="caption" color="secondary">
            {t('ride.cargo_description', { defaultValue: 'Renta un triciclo para transportar mercancia. Se cobra por hora desde que llega el conductor. Minimo 1 hora.' })}
          </Text>
        </Card>
      )}

      {/* Delivery fields (only when mensajeria is selected) */}
      {draft.serviceType === 'mensajeria' && (
        <Card variant="outlined" padding="md" className="mb-4">
          <Text variant="label" className="mb-3">
            {t('ride.delivery_details', { defaultValue: 'Detalles del envio' })}
          </Text>
          <View className="mb-1">
            <Text variant="caption" color="secondary">
              {t('ride.package_description', { defaultValue: 'Descripcion del paquete' })}
              <Text variant="caption" className="text-red-500"> *</Text>
            </Text>
          </View>
          <Input
            placeholder={t('ride.package_description', { defaultValue: 'Descripcion del paquete' })}
            value={draft.delivery.packageDescription}
            onChangeText={(v) => setDeliveryField('packageDescription', v)}
            className="mb-3"
          />
          <View className="mb-1">
            <Text variant="caption" color="secondary">
              {t('ride.recipient_name', { defaultValue: 'Nombre del destinatario' })}
              <Text variant="caption" className="text-red-500"> *</Text>
            </Text>
          </View>
          <Input
            placeholder={t('ride.recipient_name', { defaultValue: 'Nombre del destinatario' })}
            value={draft.delivery.recipientName}
            onChangeText={(v) => setDeliveryField('recipientName', v)}
            className="mb-3"
          />
          <View className="mb-1">
            <Text variant="caption" color="secondary">
              {t('ride.recipient_phone', { defaultValue: 'Telefono del destinatario' })}
              <Text variant="caption" className="text-red-500"> *</Text>
            </Text>
          </View>
          <Input
            placeholder={t('ride.recipient_phone', { defaultValue: 'Telefono del destinatario' })}
            value={draft.delivery.recipientPhone}
            onChangeText={(v) => setDeliveryField('recipientPhone', v)}
            keyboardType="phone-pad"
            className="mb-3"
          />
          <View className="flex-row gap-3">
            <View className="flex-1">
              <View className="mb-1">
                <Text variant="caption" color="secondary">
                  {t('ride.estimated_weight', { defaultValue: 'Peso (kg)' })}
                  {' '}
                  <Text variant="caption" color="tertiary" style={{ fontSize: 11 }}>
                    ({t('home.optional', { defaultValue: 'opcional' })})
                  </Text>
                </Text>
              </View>
              <Input
                placeholder={t('ride.estimated_weight', { defaultValue: 'Peso (kg)' })}
                value={draft.delivery.estimatedWeightKg}
                onChangeText={(v) => setDeliveryField('estimatedWeightKg', v)}
                keyboardType="numeric"
              />
            </View>
            <View className="flex-1">
              <View className="mb-1">
                <Text variant="caption" color="secondary">
                  {t('ride.special_instructions', { defaultValue: 'Instrucciones' })}
                  {' '}
                  <Text variant="caption" color="tertiary" style={{ fontSize: 11 }}>
                    ({t('home.optional', { defaultValue: 'opcional' })})
                  </Text>
                </Text>
              </View>
              <Input
                placeholder={t('ride.special_instructions', { defaultValue: 'Instrucciones' })}
                value={draft.delivery.specialInstructions}
                onChangeText={(v) => setDeliveryField('specialInstructions', v)}
              />
            </View>
          </View>
        </Card>
      )}

      {/* Passenger count selector */}
      {draft.serviceType !== 'triciclo_cargo' && draft.serviceType !== 'mensajeria' && (
        (() => {
          const maxP = draft.serviceType === 'moto_standard' ? 1
            : (draft.serviceType === 'triciclo_basico' || draft.serviceType === 'triciclo_premium') ? 8
            : 4; // auto_standard, auto_confort
          if (maxP <= 1) return null;
          return (
            <View className="mb-4">
              <Text variant="label" className="mb-2">
                {t('ride.passengers', { defaultValue: 'Pasajeros' })}
              </Text>
              <View className="flex-row gap-2">
                {Array.from({ length: maxP }, (_, i) => i + 1).map((n) => (
                  <Pressable
                    key={n}
                    className={`w-10 h-10 rounded-lg items-center justify-center ${draft.passengerCount === n ? 'bg-primary-500' : 'bg-neutral-100'}`}
                    onPress={() => setPassengerCount(n)}
                  >
                    <Text variant="bodySmall" className={draft.passengerCount === n ? 'text-white font-bold' : 'text-neutral-600'}>
                      {n}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text variant="caption" color="tertiary" className="mt-2">
                {t('home.passenger_capacity_hint', { defaultValue: 'Capacidad: Moto 1, Triciclo 2-3, Auto 1-4' })}
              </Text>
            </View>
          );
        })()
      )}

      {/* Corporate account toggle */}
      {corporateAccounts.length > 0 && (
        <View className="mb-4">
          <Text variant="label" className="mb-2">
            {t('corporate.riding_as_label', { defaultValue: 'Cobrar a' })}
          </Text>
          <View className="flex-row gap-3" accessibilityRole="radiogroup">
            <Pressable
              className={`flex-1 py-3 rounded-xl items-center ${
                !draft.corporateAccountId ? 'bg-primary-500' : 'bg-neutral-100'
              }`}
              onPress={() => setCorporateAccount(null)}
              accessibilityRole="radio"
              accessibilityState={{ selected: !draft.corporateAccountId }}
            >
              <Text
                variant="caption"
                color={!draft.corporateAccountId ? 'inverse' : 'secondary'}
              >
                {t('corporate.personal')}
              </Text>
            </Pressable>
            {corporateAccounts.map((acc) => (
              <Pressable
                key={acc.id}
                className={`flex-1 py-3 rounded-xl items-center ${
                  draft.corporateAccountId === acc.id ? 'bg-primary-500' : 'bg-neutral-100'
                }`}
                onPress={() => setCorporateAccount(acc.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: draft.corporateAccountId === acc.id }}
              >
                <Text
                  variant="caption"
                  color={draft.corporateAccountId === acc.id ? 'inverse' : 'secondary'}
                  numberOfLines={1}
                >
                  {acc.name}
                </Text>
                {acc.monthly_budget_trc > 0 && (
                  <Text
                    variant="caption"
                    color={draft.corporateAccountId === acc.id ? 'inverse' : 'tertiary'}
                    style={{ fontSize: 9 }}
                  >
                    {formatTRC(acc.monthly_budget_trc - acc.current_month_spent)} {t('corporate.remaining', { defaultValue: 'disp.' })}
                  </Text>
                )}
              </Pressable>
            ))}
          </View>
          {draft.corporateAccountId && (
            <View className="mt-2 bg-primary-50 rounded-lg px-3 py-2">
              <Text variant="caption" color="accent">
                {t('corporate.riding_as', {
                  company: corporateAccounts.find((a) => a.id === draft.corporateAccountId)?.name ?? '',
                })}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Payment method */}
      {!draft.corporateAccountId && (
        <>
          <Text variant="label" className="mb-2">{t('ride.payment_method')}</Text>
          <View className="flex-row gap-3 mb-4" accessibilityRole="radiogroup">
            {(['cash', 'tricicoin'] as const).map((pm) => (
              <Pressable
                key={pm}
                className={`flex-1 py-3 rounded-xl items-center ${
                  draft.paymentMethod === pm ? 'bg-primary-500' : 'bg-neutral-100'
                }`}
                onPress={() => setPaymentMethod(pm)}
                accessibilityRole="radio"
                accessibilityState={{ selected: draft.paymentMethod === pm }}
              >
                <Text
                  variant="caption"
                  color={draft.paymentMethod === pm ? 'inverse' : 'secondary'}
                  className="text-center"
                >
                  {t(`payment.${pm}` as const)}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {/* Schedule ride */}
      <View className="mb-6">
        <Pressable
          className={`flex-row items-center rounded-xl px-4 py-3 ${
            draft.scheduledAt ? 'bg-primary-50 border border-primary-500' : 'bg-neutral-100'
          }`}
          onPress={() => {
            if (draft.scheduledAt) {
              setScheduledAt(null);
            } else {
              setShowDatePicker(true);
            }
          }}
        >
          <Ionicons
            name="calendar-outline"
            size={20}
            color={draft.scheduledAt ? colors.brand.orange : colors.neutral[500]}
          />
          <Text
            variant="body"
            color={draft.scheduledAt ? 'accent' : 'secondary'}
            className="ml-3 flex-1"
          >
            {draft.scheduledAt
              ? `${draft.scheduledAt.toLocaleDateString('es-CU', { day: 'numeric', month: 'short' })} — ${draft.scheduledAt.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' })}`
              : t('ride.schedule_ride', { defaultValue: 'Programar viaje' })}
          </Text>
          {draft.scheduledAt && (
            <Ionicons name="close-circle" size={20} color={colors.neutral[400]} />
          )}
        </Pressable>
      </View>

      {/* Date picker */}
      {showDatePicker && (
        <DateTimePicker
          value={draft.scheduledAt ?? minScheduleDate}
          mode="date"
          minimumDate={minScheduleDate}
          onChange={(_e, date) => {
            setShowDatePicker(false);
            if (date) {
              const merged = draft.scheduledAt ? new Date(draft.scheduledAt) : new Date(date);
              merged.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
              setScheduledAt(merged);
              // On Android, show time picker right after date
              if (Platform.OS === 'android') {
                setTimeout(() => setShowTimePicker(true), 300);
              } else {
                setShowTimePicker(true);
              }
            }
          }}
        />
      )}

      {/* Time picker */}
      {showTimePicker && (
        <DateTimePicker
          value={draft.scheduledAt ?? minScheduleDate}
          mode="time"
          minimumDate={minScheduleDate}
          onChange={(_e, time) => {
            setShowTimePicker(false);
            if (time) {
              const merged = draft.scheduledAt ? new Date(draft.scheduledAt) : new Date(time);
              merged.setHours(time.getHours(), time.getMinutes());
              setScheduledAt(merged);
            }
          }}
        />
      )}

      {error && (
        <Text variant="bodySmall" color="error" className="mb-4 text-center">
          {error}
        </Text>
      )}

      <Button
        title={draft.scheduledAt
          ? t('ride.schedule_confirm', { defaultValue: 'Programar viaje' })
          : t('ride.get_estimate', { defaultValue: 'Ver tarifa estimada' })}
        size="lg"
        fullWidth
        onPress={requestEstimate}
        loading={isFareEstimating}
        disabled={!canEstimate}
      />
    </View>
  );
}

// ── Reviewing View (BottomSheet) ───────────────────────────

function ReviewingView() {
  const { t } = useTranslation('rider');
  const { isTablet } = useResponsive();
  const { draft, fareEstimate, setFlowStep, isLoading, isFareEstimating, error, promoCode, promoResult, setPromoCode, splits, setInsurance, setRidePreferences } = useRideStore();
  const { requestEstimate, confirmRide, validatePromo, validatingPromo } = useRideActions();
  const [promoExpanded, setPromoExpanded] = useState(false);
  const insuranceEnabled = useFeatureFlag('trip_insurance_enabled');
  const preferencesEnabled = useFeatureFlag('ride_preferences_enabled');
  const { accounts: corporateAccounts } = useCorporateAccounts();
  const debouncedConfirmRide = useDebouncePress(() => { triggerHaptic('medium'); confirmRide(); });
  const [splitSheetVisible, setSplitSheetVisible] = useState(false);
  const routeCoordinates = useRoutePolyline(draft.pickup?.location, draft.dropoff?.location);
  const nearbyVehicles = useNearbyVehicles(
    draft.pickup?.location?.latitude ?? null,
    draft.pickup?.location?.longitude ?? null,
  );

  if (!fareEstimate) {
    if (isLoading) {
      return (
        <View className="pt-4 flex-1">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      );
    }
    return null;
  }

  const discount = promoResult?.valid ? promoResult.discountAmount : 0;

  return (
    <View className="pt-4 flex-1">
      {/* Map preview with route polyline */}
      <RideMapView
        pickupLocation={draft.pickup?.location ?? null}
        dropoffLocation={draft.dropoff?.location ?? null}
        routeCoordinates={routeCoordinates}
        nearbyVehicles={nearbyVehicles}
        waypointLocations={draft.waypoints
          .filter((wp) => wp.location)
          .map((wp) => wp.location!)}
        height={isTablet ? 250 : 150}
      />
      {nearbyVehicles.length > 0 && (
        <View className="mt-1 mb-1">
          <Text variant="caption" color="secondary" className="text-center">
            {t('ride.nearby_vehicles', { count: nearbyVehicles.length })}
          </Text>
        </View>
      )}
      <View className="h-3" />

      {/* Route summary */}
      <Card variant="outlined" padding="md" className="mb-4">
        <RouteSummary
          pickupAddress={draft.pickup?.address ?? ''}
          dropoffAddress={draft.dropoff?.address ?? ''}
          pickupLabel={t('ride.pickup')}
          dropoffLabel={t('ride.dropoff')}
          waypoints={draft.waypoints.map((wp, i) => ({
            address: wp.address,
            label: t('ride.stop_n', { n: i + 1, defaultValue: `Parada ${i + 1}` }),
          }))}
        />
        {draft.scheduledAt && (
          <View className="flex-row items-center mt-3 pt-3 border-t border-neutral-200">
            <Ionicons name="calendar-outline" size={16} color={colors.brand.orange} />
            <Text variant="bodySmall" color="accent" className="ml-2">
              {t('ride.scheduled_for', { defaultValue: 'Programado' })}:{' '}
              {draft.scheduledAt.toLocaleDateString('es-CU', { day: 'numeric', month: 'short' })} — {draft.scheduledAt.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        )}
      </Card>

      {/* Corporate account info */}
      {draft.corporateAccountId && (() => {
        const corp = corporateAccounts.find((a) => a.id === draft.corporateAccountId);
        if (!corp) return null;
        const remaining = corp.monthly_budget_trc > 0
          ? corp.monthly_budget_trc - corp.current_month_spent
          : null;
        return (
          <Card variant="filled" padding="md" className="mb-4" style={{ backgroundColor: 'rgba(255, 77, 0, 0.06)' }}>
            <View className="flex-row items-center mb-1">
              <Ionicons name="business-outline" size={16} color={colors.brand.orange} />
              <Text variant="bodySmall" className="ml-2 font-bold">
                {corp.name}
              </Text>
            </View>
            {remaining != null && (
              <Text variant="caption" color="secondary">
                {t('corporate.budget_remaining', {
                  amount: formatTRC(remaining),
                  defaultValue: 'Presupuesto restante: {{amount}}',
                })}
              </Text>
            )}
            {corp.per_ride_cap_trc > 0 && (
              <Text variant="caption" color="secondary">
                {t('corporate.per_ride_cap', {
                  amount: formatTRC(corp.per_ride_cap_trc),
                  defaultValue: 'Máximo por viaje: {{amount}}',
                })}
              </Text>
            )}
          </Card>
        );
      })()}

      {/* Fare breakdown */}
      <View className="mb-4">
        <FareBreakdownCard
          title={t('ride.fare_breakdown', { defaultValue: 'Desglose de tarifa' })}
          baseFareCup={fareEstimate.base_fare_cup}
          distanceM={fareEstimate.estimated_distance_m}
          perKmRateCup={fareEstimate.per_km_rate_cup}
          durationS={fareEstimate.estimated_duration_s}
          perMinRateCup={fareEstimate.per_minute_rate_cup}
          surgeMultiplier={fareEstimate.surge_multiplier ?? 1}
          surgeLabel={fareEstimate.surge_multiplier && fareEstimate.surge_multiplier > 1 ? t('ride.surge_active', { defaultValue: 'Tarifa dinámica' }) : undefined}
          surgeType={fareEstimate.surge_type}
          totalCup={fareEstimate.estimated_fare_cup}
          totalTrc={fareEstimate.estimated_fare_trc}
          totalLabel={t('ride.estimated_fare')}
          discountTrc={discount}
          discountLabel={discount > 0 ? t('ride.discount', { defaultValue: 'Descuento' }) : undefined}
          minFareApplied={fareEstimate.min_fare_applied}
          minFareNote={fareEstimate.min_fare_applied ? t('ride.min_fare_note', { defaultValue: 'Se aplicó tarifa mínima' }) : undefined}
          fareRangeMinTrc={fareEstimate.fare_range_min_trc}
          fareRangeMaxTrc={fareEstimate.fare_range_max_trc}
          fareRangeLabel={t('ride.fare_range', { defaultValue: 'Rango estimado' })}
          insurancePremiumTrc={draft.insuranceSelected ? (fareEstimate.insurance_premium_trc ?? 0) : 0}
          insuranceLabel={draft.insuranceSelected ? t('ride.insurance_premium', { defaultValue: 'Seguro de viaje' }) : undefined}
          paymentMethod={draft.paymentMethod === 'tricicoin' ? 'tricicoin' : 'cash'}
          labels={{
            baseFare: t('ride.base_fare'),
            distanceCharge: t('ride.distance_charge'),
            timeCharge: t('ride.time_charge'),
            subtotal: t('ride.subtotal', { defaultValue: 'Subtotal' }),
          }}
        />
      </View>

      {/* Surge pricing explanation card (8.1) */}
      {fareEstimate.surge_multiplier != null && fareEstimate.surge_multiplier > 1 && (
        <View
          className="flex-row items-center rounded-xl px-4 py-3 mb-4"
          style={{ backgroundColor: '#FEF3C7' }}
          accessibilityRole="alert"
        >
          <Ionicons name="flash" size={20} color="#D97706" />
          <View className="flex-1 ml-3">
            <Text variant="bodySmall" className="font-bold" style={{ color: '#92400E' }}>
              {t('home.surge_active_label', { defaultValue: 'Tarifa dinámica activa' })} (x{fareEstimate.surge_multiplier})
            </Text>
            <Text variant="caption" style={{ color: '#92400E' }}>
              {t('home.surge_explanation', { defaultValue: 'Los precios son más altos debido a la alta demanda en tu zona' })}
            </Text>
          </View>
        </View>
      )}

      {/* ETA display */}
      {fareEstimate.estimated_duration_s != null && fareEstimate.estimated_duration_s > 0 && (
        <View className="flex-row items-center mb-4 px-1">
          <Ionicons name="time-outline" size={16} color={colors.neutral[500]} />
          <Text variant="bodySmall" color="secondary" className="ml-2">
            {t('home.estimated_time', { defaultValue: 'Tiempo estimado' })}: {Math.ceil(fareEstimate.estimated_duration_s / 60)} {t('home.min', { defaultValue: 'min' })}
          </Text>
        </View>
      )}

      {/* Trip insurance toggle */}
      {insuranceEnabled && fareEstimate.insurance_available && fareEstimate.insurance_premium_trc != null && (
        <Pressable
          className={`flex-row items-center rounded-xl px-4 py-3 mb-4 ${
            draft.insuranceSelected ? 'bg-primary-50 border border-primary-500' : 'bg-neutral-100'
          }`}
          onPress={() => setInsurance(!draft.insuranceSelected)}
          accessibilityRole="switch"
          accessibilityState={{ checked: draft.insuranceSelected }}
          accessibilityLabel={t('ride.insurance_toggle', { defaultValue: 'Seguro de viaje' })}
        >
          <Ionicons
            name="shield-checkmark-outline"
            size={20}
            color={draft.insuranceSelected ? colors.brand.orange : colors.neutral[500]}
          />
          <View className="flex-1 ml-3">
            <Text variant="body" color={draft.insuranceSelected ? 'primary' : undefined}>
              {t('ride.insurance_toggle', { defaultValue: 'Seguro de viaje' })}
            </Text>
            <Text variant="caption" color="secondary">
              {fareEstimate.insurance_coverage_desc ?? t('ride.insurance_desc', { defaultValue: 'Cobertura por accidentes y daños' })}
              {' · '}
              {formatTRC(fareEstimate.insurance_premium_trc)}
            </Text>
          </View>
          <Switch
            value={draft.insuranceSelected}
            onValueChange={(val) => setInsurance(val)}
            trackColor={{ false: '#D1D5DB', true: colors.brand.orange }}
            thumbColor="white"
          />
        </Pressable>
      )}

      {/* Promo code */}
      {!promoExpanded && !promoResult?.valid ? (
        <Pressable
          className="mb-6 py-2"
          onPress={() => setPromoExpanded(true)}
        >
          <Text variant="bodySmall" color="accent" className="text-center underline">
            {t('home.have_promo_code', { defaultValue: '¿Tienes un código?' })}
          </Text>
        </Pressable>
      ) : (
        <Card variant="outlined" padding="md" className="mb-6">
          <Text variant="label" className="mb-2">{t('ride.promo_code_label', { defaultValue: 'Código promocional' })}</Text>
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Input
                placeholder={t('ride.promo_code_label', { defaultValue: 'Ingresa tu código' })}
                value={promoCode}
                onChangeText={setPromoCode}
                autoCapitalize="characters"
              />
            </View>
            <Button
              title={t('ride.apply', { defaultValue: 'Aplicar' })}
              size="sm"
              variant="outline"
              onPress={validatePromo}
              loading={validatingPromo}
              disabled={!promoCode.trim()}
            />
          </View>
          {promoResult && (
            <Text
              variant="caption"
              color={promoResult.valid ? 'accent' : 'error'}
              className={promoResult.valid ? 'mt-2 text-green-600' : 'mt-2'}
            >
              {promoResult.valid
                ? t('ride.discount_applied', { defaultValue: `Descuento de ${formatTRC(promoResult.discountAmount)} aplicado`, amount: formatTRC(promoResult.discountAmount) })
                : promoResult.error ?? t('ride.promo_invalid')}
            </Text>
          )}
        </Card>
      )}

      {/* Split fare — only for tricicoin AND when ride exists (has rideId) */}
      {draft.paymentMethod === 'tricicoin' && fareEstimate && activeRide?.id && (
        <>
          <Pressable
            className={`flex-row items-center rounded-xl px-4 py-3 mb-6 ${
              splits.length > 0 ? 'bg-primary-50 border border-primary-500' : 'bg-neutral-100'
            }`}
            onPress={() => setSplitSheetVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={t('ride.split_fare', { defaultValue: 'Dividir tarifa' })}
          >
            <Ionicons
              name="people-outline"
              size={20}
              color={splits.length > 0 ? colors.brand.orange : colors.neutral[500]}
            />
            <Text
              variant="body"
              color={splits.length > 0 ? 'accent' : 'secondary'}
              className="ml-3 flex-1"
            >
              {splits.length > 0
                ? t('ride.split_with_count', {
                    count: splits.length,
                    defaultValue: 'Dividido con {{count}} persona(s)',
                  })
                : t('ride.split_fare', { defaultValue: 'Dividir tarifa' })}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={colors.neutral[400]} />
          </Pressable>

          <FareSplitSheet
            visible={splitSheetVisible}
            onClose={() => setSplitSheetVisible(false)}
            rideId={activeRide?.id ?? ''}
            estimatedFareTrc={fareEstimate.estimated_fare_trc}
          />
        </>
      )}

      {/* Ride preferences */}
      {preferencesEnabled && (
        <Pressable
          className={`flex-row items-center rounded-xl px-4 py-3 mb-4 ${
            Object.values(draft.ridePreferences).some(Boolean) ? 'bg-primary-50 border border-primary-500' : 'bg-neutral-100'
          }`}
          onPress={() => router.push('/profile/ride-preferences')}
          accessibilityRole="button"
          accessibilityLabel={t('ride.preferences_button', { defaultValue: 'Preferencias de viaje' })}
        >
          <Ionicons
            name="options-outline"
            size={20}
            color={Object.values(draft.ridePreferences).some(Boolean) ? colors.brand.orange : colors.neutral[500]}
          />
          <View className="flex-1 ml-3">
            <Text
              variant="body"
              color={Object.values(draft.ridePreferences).some(Boolean) ? 'accent' : 'secondary'}
            >
              {t('ride.preferences_button', { defaultValue: 'Preferencias de viaje' })}
            </Text>
            {Object.values(draft.ridePreferences).some(Boolean) && (
              <View className="flex-row flex-wrap gap-1 mt-1">
                {draft.ridePreferences.quiet_mode && (
                  <View className="bg-primary-100 px-2 py-0.5 rounded-full">
                    <Text className="text-xs text-primary-700">{t('ride.pref_quiet', { defaultValue: 'Silencio' })}</Text>
                  </View>
                )}
                {draft.ridePreferences.temperature === 'cool' && (
                  <View className="bg-primary-100 px-2 py-0.5 rounded-full">
                    <Text className="text-xs text-primary-700">{t('ride.pref_cool', { defaultValue: 'AC fresco' })}</Text>
                  </View>
                )}
                {draft.ridePreferences.temperature === 'warm' && (
                  <View className="bg-primary-100 px-2 py-0.5 rounded-full">
                    <Text className="text-xs text-primary-700">{t('ride.pref_warm', { defaultValue: 'Cálido' })}</Text>
                  </View>
                )}
                {draft.ridePreferences.conversation_ok && (
                  <View className="bg-primary-100 px-2 py-0.5 rounded-full">
                    <Text className="text-xs text-primary-700">{t('ride.pref_conversation', { defaultValue: 'Conversación' })}</Text>
                  </View>
                )}
                {draft.ridePreferences.luggage_trunk && (
                  <View className="bg-primary-100 px-2 py-0.5 rounded-full">
                    <Text className="text-xs text-primary-700">{t('ride.pref_trunk', { defaultValue: 'Maletero' })}</Text>
                  </View>
                )}
              </View>
            )}
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.neutral[400]} />
        </Pressable>
      )}

      {/* Inline error banner with retry */}
      {error && (
        <View className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4 flex-row items-center">
          <Ionicons name="alert-circle" size={20} color="#DC2626" />
          <Text variant="bodySmall" color="error" className="flex-1 ml-2">
            {error}
          </Text>
          <Pressable
            className="bg-red-500 rounded-lg px-3 py-1.5 ml-2"
            onPress={requestEstimate}
          >
            <Text variant="caption" color="inverse" className="font-semibold">
              {t('home.retry_estimate', { defaultValue: 'Reintentar' })}
            </Text>
          </Pressable>
        </View>
      )}

      <Button
        title={t('ride.confirm_ride', { defaultValue: 'Confirmar viaje' })}
        size="lg"
        fullWidth
        onPress={debouncedConfirmRide}
        loading={isLoading}
        className="mb-3"
      />
      <Button
        title={t('home.back', { defaultValue: 'Volver' })}
        variant="ghost"
        size="lg"
        fullWidth
        onPress={() => setFlowStep('selecting')}
      />
    </View>
  );
}

// ── Searching View ─────────────────────────────────────────

function SearchingView() {
  const { t } = useTranslation('rider');
  const { isTablet } = useResponsive();
  const { isLoading, error, activeRide } = useRideStore();
  const { cancelRide } = useRideActions();
  const routeCoordinates = useRoutePolyline(
    activeRide?.pickup_location ?? null,
    activeRide?.dropoff_location ?? null,
  );

  const searchSteps = useMemo(() => [
    { key: 'searching', label: t('ride.searching_driver') },
    { key: 'accepted', label: t('ride.status_accepted') },
    { key: 'driver_en_route', label: t('ride.status_driver_en_route') },
    { key: 'in_progress', label: t('ride.status_in_progress') },
  ], [t]);

  return (
    <View className="pt-4 flex-1 items-center">
      {/* Map showing pickup + dropoff with route */}
      {activeRide && (
        <>
          <RideMapView
            pickupLocation={activeRide.pickup_location}
            dropoffLocation={activeRide.dropoff_location}
            routeCoordinates={routeCoordinates}
            height={isTablet ? 300 : 180}
          />
          <View className="h-4" />
        </>
      )}

      <StatusStepper
        steps={searchSteps}
        currentStep="searching"
        className="w-full mb-8"
      />

      <ActivityIndicator size="large" color={colors.brand.orange} className="mb-4" />

      <Text variant="h4" className="mb-2 text-center">
        {t('ride.searching_driver')}
      </Text>
      <Text variant="bodySmall" color="secondary" className="mb-8 text-center">
        {t('ride.searching_wait', { defaultValue: 'Esto puede tomar hasta 2 minutos' })}
      </Text>

      {error && (
        <Text variant="bodySmall" color="error" className="mb-4 text-center">
          {error}
        </Text>
      )}

      <Button
        title={t('ride.cancel_ride')}
        variant="outline"
        size="lg"
        fullWidth
        onPress={() => cancelRide(t('ride.canceled_by_passenger', { defaultValue: 'Cancelado por el pasajero' }))}
        loading={isLoading}
      />
    </View>
  );
}

export default function HomeScreen() {
  if (Platform.OS === 'web') return <WebHomeScreen />;
  return <NativeHomeScreen />;
}
