import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { View, Pressable, ActivityIndicator, Platform, Switch, Image, Animated, ScrollView, StyleSheet, TextInput, Alert, Linking, AppState } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useFocusEffect } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { ServiceTypeCard } from '@tricigo/ui/ServiceTypeCard';
import Toast from 'react-native-toast-message';
import { formatTRC, formatCUP, triggerSelection, triggerHaptic, suggestPickupPoint, logger, haversineDistance, formatArrivalTime, serviceTypeToVehicleType, tricigoCategoryEmoji, deliveryVehicleToSlug, INCOMPATIBILITY_REASON_LABELS, MAP_STYLE_LIGHT, MAP_COLORS, fetchRoute, resolveAnnouncementCta, formatRating } from '@tricigo/utils';
import * as Location from 'expo-location';
import { useTranslation } from '@tricigo/i18n';
import { walletService, customerService, useFeatureFlag, notificationService, getSupabaseClient, blogService, type BlogPost, announcementService, type HomeAnnouncement, exchangeRateService, promotionService, type ActivePromotion } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { useNotificationStore } from '@/stores/notification.store';
import { useThemeStore } from '@/stores/theme.store';
import { useRideActions } from '@/hooks/useRide';
import { useRoutePolyline } from '@/hooks/useRoutePolyline';
import { WebMapView } from '@/components/WebMapView';
import type { WebMapViewRef } from '@/components/WebMapView';
import { WebAddressInput } from '@/components/WebAddressInput';
import { useNearbyVehicles } from '@/hooks/useNearbyVehicles';
import { useDeliveryVehicles } from '@/hooks/useDeliveryVehicles';
import { useTestVehicles } from '@/hooks/useTestVehicles';
import { SubmitPoiSheet } from '@tricigo/ui';
import { RideActiveView } from '@/components/RideActiveView';
import { RideCompleteView } from '@/components/RideCompleteView';
import { RideMapView } from '@/components/RideMapView';
import { AddressSearchInput } from '@/components/AddressSearchInput';
import { ConfirmLocationScreen } from '@/components/ConfirmLocationScreen';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';
import { RouteSummary } from '@tricigo/ui/RouteSummary';
import { Skeleton, SkeletonCard } from '@tricigo/ui/Skeleton';
import { FareBreakdownCard } from '@tricigo/ui/FareBreakdownCard';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { colors, cubanLight, cubanDark } from '@tricigo/theme';
import {
  DisplayHeading,
  BalanceHeroCard,
  ServiceIconButton,
  RecentPlacesList,
  CapitolioDivider,
  StopsList,
  WeatherChip,
} from '@tricigo/ui';
import { useWeather } from '@/hooks/useWeather';
import { PartnerPlacesCarousel } from '@/components/PartnerPlacesCarousel';
import { PartnerCouponBanner } from '@/components/PartnerCouponBanner';
import { useTokens } from '@/hooks/useTokens';
import { Ionicons } from '@expo/vector-icons';
import { useRecentAddresses } from '@/hooks/useRecentAddresses';
import { useDestinationPredictions } from '@/hooks/useDestinationPredictions';
import { vehicleSelectionImages } from '@/utils/vehicleImages';
import { SplitInviteCard } from '@/components/SplitInviteCard';
import { FareSplitSheet } from '@/components/FareSplitSheet';
import type { SavedLocation, ServiceTypeSlug, CorporateAccount, PackageCategory } from '@tricigo/types';
import { PACKAGE_CATEGORIES } from '@tricigo/types';
import type { PredictedDestination } from '@tricigo/utils';
import { useCorporateAccounts } from '@/hooks/useCorporateAccounts';
import { rideService } from '@tricigo/api/services/ride';
import { reverseGeocode } from '@tricigo/utils';
import { NotificationPermissionSheet } from '@/components/NotificationPermissionSheet';
import { UpdateAvailableSheet } from '@/components/UpdateAvailableSheet';
import { OnboardingOverlay } from '@/components/OnboardingOverlay';
import { useRiderLocationSharing } from '@/hooks/useRiderLocationSharing';
import { useSearchingDrivers } from '@/hooks/useSearchingDrivers';
import { useRideOfferStats } from '@/hooks/useRideOfferStats';
import { DriverInfoMiniCard } from '@/components/DriverInfoMiniCard';
import { AcceptedDriverCard } from '@/components/AcceptedDriverCard';
import { WebActiveRideView } from '@/components/WebActiveRideView';

// Mapbox GL loaded lazily inside components — NOT at module level
// Module-level require can crash the entire JS context if native module fails
function getMapboxGL(): any {
  try {
    const MapboxGL = require('@rnmapbox/maps').default;
    const token = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
    if (token) MapboxGL.setAccessToken(token);
    return MapboxGL;
  } catch { return null; }
}

// Coin icon for BalanceBadge
const tricoinSmall = require('../../assets/coins/tricoin-small.png');

function useDebouncePress(callback: (...args: unknown[]) => void, delayMs = 1000) {
  const lastPress = useRef(0);
  return useCallback((...args: unknown[]) => {
    const now = Date.now();
    if (now - lastPress.current < delayMs) return;
    lastPress.current = now;
    callback(...args);
  }, [callback, delayMs]);
}

// Service type definitions for web booking
const WEB_SERVICES: { name: string; desc: string; slug: ServiceTypeSlug; img: any }[] = [
  { name: 'Triciclo', desc: 'Económico', slug: 'triciclo_basico', img: require('../../assets/vehicles/selection/triciclo.png') },
  { name: 'Moto', desc: 'Rápido', slug: 'moto_standard', img: require('../../assets/vehicles/selection/moto.png') },
  // TODO: dedicated side-view almendrón asset pending. Using selection/auto.png
  // until then (top-down markers/auto_clasico.png looked off in card UI).
  { name: 'Auto', desc: 'Cómodo', slug: 'auto_standard', img: require('../../assets/vehicles/selection/auto.png') },
  { name: 'Confort', desc: 'Premium', slug: 'auto_confort', img: require('../../assets/vehicles/selection/confort.png') },
  { name: 'Envío', desc: 'Delivery', slug: 'mensajeria', img: require('../../assets/vehicles/selection/mensajeria.png') },
];

const DELIVERY_VEHICLES: { slug: ServiceTypeSlug; label: string; img: any }[] = [
  { slug: 'moto_standard', label: 'Moto', img: require('../../assets/vehicles/selection/moto.png') },
  { slug: 'triciclo_basico', label: 'Triciclo', img: require('../../assets/vehicles/selection/triciclo.png') },
  { slug: 'auto_standard', label: 'Auto', img: require('../../assets/vehicles/selection/auto.png') },
  { slug: 'auto_confort', label: 'Confort', img: require('../../assets/vehicles/selection/confort.png') },
];

const DELIVERY_CATS = [
  { value: 'documentos' as PackageCategory, icon: '📄', label: 'Documentos' },
  { value: 'comida' as PackageCategory, icon: '🍔', label: 'Comida' },
  { value: 'paquete_pequeno' as PackageCategory, icon: '📦', label: 'Pequeño' },
  { value: 'paquete_grande' as PackageCategory, icon: '📫', label: 'Grande' },
  { value: 'fragil' as PackageCategory, icon: '⚠️', label: 'Frágil' },
];

type WebSelectionStep = 'pickup' | 'dropoff' | 'done';

interface LocationPreset {
  latitude: number;
  longitude: number;
  address?: string;
  label?: string;
}

/* ── CSS keyframes for web searching animations ── */
const WEB_SEARCHING_CSS = `
  @keyframes ws-ripple {
    0% { transform: translate(-50%,-50%) scale(0.8); opacity: 0.5; }
    100% { transform: translate(-50%,-50%) scale(2.4); opacity: 0; }
  }
  @keyframes ws-progress {
    from { width: 0%; }
    to { width: 100%; }
  }
  @keyframes ws-fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes ws-glow {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255,77,0,0.3); }
    50% { box-shadow: 0 0 0 12px rgba(255,77,0,0); }
  }
  @keyframes ws-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
`;

const WEB_SEARCH_MESSAGES = [
  'Buscando el mejor conductor para ti...',
  'Verificando conductores cercanos...',
  'Conductores evaluando tu solicitud...',
  'Ampliando el radio de búsqueda...',
  'Pocos conductores disponibles, esperando...',
];

/* ── Premium Web Searching State ── */
function WebSearchingState({
  pickup, dropoff, pickupAddress, dropoffAddress, routeCoords,
  selectedEstimate, serviceType, onReset, font, paymentMethod,
}: {
  pickup: LocationPreset | null;
  dropoff: LocationPreset | null;
  pickupAddress: string;
  dropoffAddress: string;
  routeCoords: [number, number][];
  selectedEstimate: any;
  serviceType: string;
  onReset: () => void;
  font: { fontFamily: string };
  paymentMethod: string;
}) {
  const [searchPhase, setSearchPhase] = useState(0);
  const [searchTimedOut, setSearchTimedOut] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  // ── Interactive searching: real-time driver presence ──
  const activeRideId = useRideStore((s) => s.activeRide?.id ?? null);
  const { searchingDrivers, acceptedDriver } = useSearchingDrivers(activeRideId);

  // ── Dark mode: single palette object (mirrors cubanDark) ──
  // NativeWind `dark:` does not apply to inline styles, so the web
  // render path reads the theme store directly and references `c.*`.
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const c = isDark
    ? {
        bg: '#0A0E1A', panel: '#11172A', surface: '#18203A', surfaceAlt: '#18203A',
        mapBg: '#0A0E1A', text: '#F4F0EA', textMuted: '#B7C4CF', textFaint: '#6B7F8F',
        border: 'rgba(244,240,234,0.12)', borderFaint: 'rgba(244,240,234,0.08)',
      }
    : {
        bg: '#f5f5f5', panel: '#fff', surface: '#fafafa', surfaceAlt: '#f3f4f6',
        mapBg: '#f0f0f0', text: '#1a1a1a', textMuted: '#6b7280', textFaint: '#9ca3af',
        border: '#e5e5e5', borderFaint: '#f0f0f0',
      };

  // Progressive messages
  useEffect(() => {
    const timers = [
      setTimeout(() => setSearchPhase(1), 15000),
      setTimeout(() => setSearchPhase(2), 30000),
      setTimeout(() => setSearchPhase(3), 60000),
      setTimeout(() => setSearchPhase(4), 90000),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  // Timeout
  useEffect(() => {
    const timeout = setTimeout(() => setSearchTimedOut(true), 120_000);
    return () => clearTimeout(timeout);
  }, []);

  // Elapsed timer
  useEffect(() => {
    const interval = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const searchMessage = WEB_SEARCH_MESSAGES[searchPhase] ?? WEB_SEARCH_MESSAGES[0];
  const fmtCUP = (v: number) => `${Math.round(v).toLocaleString('es-CU')} CUP`;
  const fmtPrice = (cupAmount: number, trcAmount?: number) =>
    paymentMethod === 'tricicoin' ? formatTRC(trcAmount ?? cupAmount) : fmtCUP(cupAmount);

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100vh', ...font }}>
      <style dangerouslySetInnerHTML={{ __html: WEB_SEARCHING_CSS }} />

      {/* ═══ LEFT: Map ═══ */}
      <div style={{ flex: 1, position: 'relative', background: c.mapBg }}>
        {pickup && dropoff && (
          <WebMapView
            pickup={{ latitude: pickup.latitude, longitude: pickup.longitude }}
            dropoff={{ latitude: dropoff.latitude, longitude: dropoff.longitude }}
            routeCoords={routeCoords}
            style={{ width: '100%', height: '100%' }}
          />
        )}

        {/* ETA Badge floating on map */}
        {selectedEstimate?.estimated_duration_s && !searchTimedOut && (
          <div style={{
            position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 20px', borderRadius: 999,
            background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(12px)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
            fontSize: 14, fontWeight: 700, color: '#1a1a1a', zIndex: 10,
            animation: 'ws-fadeIn 0.4s ease both',
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FF4D00" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
            ~{Math.ceil(selectedEstimate.estimated_duration_s / 60)} min
          </div>
        )}
      </div>

      {/* ═══ RIGHT: Searching Panel ═══ */}
      <div style={{
        width: 440, minWidth: 380, maxWidth: 480,
        display: 'flex', flexDirection: 'column',
        backgroundColor: c.panel, borderLeft: `1px solid ${c.border}`,
        overflowY: 'auto', padding: '32px 28px',
        gap: 20, ...font,
      }}>
        {/* Header */}
        <div style={{ animation: 'ws-fadeIn 0.3s ease both' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: c.textFaint, textTransform: 'uppercase' as const, letterSpacing: '0.04em', marginBottom: 4 }}>
            {serviceType === 'mensajeria' ? 'Seguimiento de envío' : 'Seguimiento de viaje'}
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: c.text, letterSpacing: '-0.02em' }}>
            {searchTimedOut ? 'Sin conductor disponible' : '¡Viaje solicitado!'}
          </div>
        </div>

        {/* Ripple Animation or Timeout */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '20px 0', animation: 'ws-fadeIn 0.4s ease both 0.05s',
        }}>
          {searchTimedOut ? (
            <>
              <div style={{
                width: 72, height: 72, borderRadius: '50%',
                background: 'rgba(156,163,175,0.1)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: 16,
              }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={c.textFaint} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: c.text, textAlign: 'center' as const, marginBottom: 6 }}>
                No encontramos conductor
              </div>
              <div style={{ fontSize: 13, color: c.textMuted, textAlign: 'center' as const, marginBottom: 16 }}>
                Intenta de nuevo o prueba con otro tipo de vehículo
              </div>
              <button onClick={onReset} style={{
                width: '100%', padding: '14px 24px', borderRadius: 12,
                background: colors.brand.orange, color: '#fff',
                fontWeight: 700, fontSize: 15, border: 'none', cursor: 'pointer',
                ...font,
              }}>
                Solicitar otro viaje
              </button>
            </>
          ) : (
            <>
              {/* Ripple circles */}
              <div style={{ position: 'relative', width: 100, height: 100, marginBottom: 16 }}>
                {[0, 0.6, 1.2].map((delay, i) => (
                  <div key={i} style={{
                    position: 'absolute', top: '50%', left: '50%',
                    width: 80, height: 80, borderRadius: '50%',
                    border: '2px solid rgba(255,77,0,0.3)',
                    animation: `ws-ripple 2.4s ease-out ${delay}s infinite`,
                  }} />
                ))}
                <div style={{
                  position: 'absolute', top: '50%', left: '50%',
                  transform: 'translate(-50%,-50%)',
                  width: 56, height: 56, borderRadius: '50%',
                  background: 'linear-gradient(135deg, #FF4D00, #FF6B2C)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 4px 16px rgba(255,77,0,0.3)',
                  animation: 'ws-glow 2s ease-in-out infinite',
                }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L19 21L12 17L5 21L12 2Z" />
                  </svg>
                </div>
              </div>

              {/* Driver accepted — celebration overlay */}
              {acceptedDriver && (
                <div style={{
                  animation: 'ws-fadeIn 0.4s ease both',
                  background: 'linear-gradient(135deg, #f0fdf4, #dcfce7)',
                  borderRadius: 14, padding: 20, width: '100%',
                  border: '2px solid #22c55e', textAlign: 'center' as const,
                  marginBottom: 12,
                }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>&#10003;</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#15803d', marginBottom: 4 }}>
                    Conductor encontrado!
                  </div>
                  <div style={{ fontSize: 14, color: '#16a34a', marginBottom: 12 }}>
                    {acceptedDriver.name} va en camino
                  </div>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: '#fff', borderRadius: 12, padding: '10px 14px',
                  }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: '50%',
                      background: colors.brand.orange,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontWeight: 700, fontSize: 16,
                      border: '2px solid #22c55e',
                    }}>
                      {acceptedDriver.name.split(' ').map(w => w[0]).join('').slice(0, 2)}
                    </div>
                    <div style={{ flex: 1, textAlign: 'left' as const }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: '#1a1a1a' }}>{acceptedDriver.name}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{formatRating(acceptedDriver.rating, 'Nuevo')}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Searching drivers count + chips */}
              {!acceptedDriver && searchingDrivers.length > 0 && (
                <div style={{
                  width: '100%', background: c.surface,
                  border: `1px solid ${c.borderFaint}`, borderRadius: 12,
                  padding: '12px 14px', marginBottom: 12,
                  animation: 'ws-fadeIn 0.3s ease both',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: colors.brand.orange,
                      animation: 'ws-pulse 2s ease-in-out infinite',
                    }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: c.text }}>
                      {searchingDrivers.length} {searchingDrivers.length === 1 ? 'conductor revisando' : 'conductores revisando'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                    {searchingDrivers
                      .filter((d, i, arr) => arr.findIndex(x => x.driverId === d.driverId) === i)
                      .map((d) => (
                      <div key={d.driverId} style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        background: c.panel, borderRadius: 20,
                        padding: '5px 10px', border: `1px solid ${c.border}`,
                        animation: 'ws-fadeIn 0.3s ease both',
                      }}>
                        <div style={{
                          width: 22, height: 22, borderRadius: '50%',
                          background: colors.brand.orange,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: '#fff', fontWeight: 700, fontSize: 9,
                        }}>
                          {d.name.split(' ').map(w => w[0]).join('').slice(0, 2)}
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 500, color: c.text }}>
                          {d.name.split(' ')[0]}
                        </span>
                        <span style={{ fontSize: 11, color: c.textFaint }}>{formatRating(d.rating, 'Nuevo')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ fontSize: 15, fontWeight: 700, color: c.text, textAlign: 'center' as const, marginBottom: 4 }}>
                {acceptedDriver ? '' : 'Buscando conductor'}
              </div>
              {!acceptedDriver && (
              <div key={searchPhase} style={{
                fontSize: 13, color: c.textMuted, textAlign: 'center' as const,
                animation: 'ws-fadeIn 0.3s ease both',
              }}>
                {searchMessage}
              </div>
              )}

              {/* Progress bar */}
              <div style={{ width: '100%', marginTop: 16, padding: '0 12px' }}>
                <div style={{ height: 3, backgroundColor: c.surfaceAlt, borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', backgroundColor: colors.brand.orange,
                    borderRadius: 2, animation: 'ws-progress 120s linear forwards',
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11, color: c.textFaint }}>
                  <span>{Math.floor(elapsedSec / 60)}:{String(elapsedSec % 60).padStart(2, '0')}</span>
                  <span>2:00</span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Status Stepper */}
        {!searchTimedOut && (
          <div style={{
            background: c.surface, border: `1px solid ${c.borderFaint}`, borderRadius: 12,
            padding: 16, animation: 'ws-fadeIn 0.4s ease both 0.1s',
          }}>
            {[
              { label: 'Buscando conductor', active: true },
              { label: 'Conductor asignado', active: false },
              { label: 'En camino a recogerte', active: false },
              { label: 'Viaje en curso', active: false },
            ].map((step, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingBottom: idx < 3 ? 12 : 0 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 24, flexShrink: 0 }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: '50%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700,
                    ...(step.active
                      ? { background: colors.brand.orange, color: '#fff', animation: 'ws-glow 2s ease-in-out infinite' }
                      : { background: c.surfaceAlt, color: c.textFaint, border: `2px solid ${c.border}` }),
                  }}>
                    {idx + 1}
                  </div>
                  {idx < 3 && (
                    <div style={{
                      width: 2, flex: 1, minHeight: 12, marginTop: 4,
                      background: step.active ? colors.brand.orange : c.border,
                      ...(step.active ? {} : {
                        background: `repeating-linear-gradient(to bottom, ${c.border} 0px, ${c.border} 3px, transparent 3px, transparent 6px)`,
                      }),
                    }} />
                  )}
                </div>
                <span style={{
                  fontSize: 13, paddingTop: 3, lineHeight: '1.3',
                  ...(step.active
                    ? { fontWeight: 700, color: c.text }
                    : { fontWeight: 500, color: c.textFaint }),
                }}>
                  {step.label}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Route Card */}
        <div style={{
          background: c.surface, border: `1px solid ${c.borderFaint}`, borderRadius: 12,
          padding: 16, animation: 'ws-fadeIn 0.4s ease both 0.15s',
        }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 4, gap: 2 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
              <div style={{ width: 2, flex: 1, minHeight: 20, background: c.border, borderRadius: 1 }} />
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: c.textFaint, textTransform: 'uppercase' as const, letterSpacing: '0.04em', marginBottom: 2 }}>Desde</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: c.text, lineHeight: '1.4' }}>{pickupAddress || 'Origen'}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: c.textFaint, textTransform: 'uppercase' as const, letterSpacing: '0.04em', marginBottom: 2 }}>Hasta</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: c.text, lineHeight: '1.4' }}>{dropoffAddress || 'Destino'}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Fare Card */}
        {selectedEstimate && (
          <div style={{
            background: c.surface, border: `1px solid ${c.borderFaint}`, borderRadius: 12,
            padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            animation: 'ws-fadeIn 0.4s ease both 0.2s',
          }}>
            <div>
              <div style={{ fontSize: 13, color: c.textMuted, fontWeight: 500 }}>Tarifa estimada</div>
              {selectedEstimate.estimated_distance_m && (
                <div style={{ fontSize: 11, color: c.textFaint, marginTop: 2 }}>
                  {(selectedEstimate.estimated_distance_m / 1000).toFixed(1)} km
                </div>
              )}
            </div>
            <div style={{ fontSize: 24, fontWeight: 800, color: colors.brand.orange, letterSpacing: '-0.02em' }}>
              {fmtPrice(selectedEstimate.estimated_fare_cup, selectedEstimate.estimated_fare_trc)}
            </div>
          </div>
        )}

        {/* Cancel button */}
        {!searchTimedOut && (
          <button onClick={onReset} style={{
            width: '100%', padding: '14px 24px', borderRadius: 12,
            background: 'transparent', color: c.textMuted,
            fontWeight: 600, fontSize: 14, cursor: 'pointer',
            border: `1.5px solid ${c.border}`, ...font,
            transition: 'all 0.2s ease',
            animation: 'ws-fadeIn 0.4s ease both 0.25s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#ef4444'; e.currentTarget.style.color = '#ef4444'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = c.border; e.currentTarget.style.color = c.textMuted; }}
          >
            Cancelar búsqueda
          </button>
        )}

        {/* Live indicator */}
        {!searchTimedOut && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 8, fontSize: 11, color: c.textFaint, fontWeight: 500,
            animation: 'ws-fadeIn 0.4s ease both 0.3s',
          }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%', background: '#22c55e',
              animation: 'ws-pulse 2s ease-in-out infinite',
            }} />
            Búsqueda en tiempo real
          </div>
        )}
      </div>
    </div>
  );
}

// Web version of home screen — full booking flow matching tricigo.com
function WebHomeScreen() {
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);
  const font = { fontFamily: 'Montserrat, system-ui, sans-serif' };

  // ── Dark mode: single palette object (mirrors cubanDark) ──
  // NativeWind `dark:` does not apply to inline styles, so the web
  // render path reads the theme store directly and references `c.*`.
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const c = isDark
    ? {
        bg: '#0A0E1A', panel: '#11172A', surface: '#18203A', surfaceAlt: '#18203A',
        inputBg: '#11172A', text: '#F4F0EA', textMuted: '#B7C4CF', textFaint: '#6B7F8F',
        border: 'rgba(244,240,234,0.12)', borderFaint: 'rgba(244,240,234,0.08)',
        cardSel: 'rgba(255,77,0,0.16)', disabled: '#2A3350',
      }
    : {
        bg: '#f5f5f5', panel: '#fff', surface: '#f9fafb', surfaceAlt: '#f3f4f6',
        inputBg: '#fff', text: '#1a1a1a', textMuted: '#6b7280', textFaint: '#9ca3af',
        border: '#e5e5e5', borderFaint: '#f0f0f0',
        cardSel: '#FFF5F0', disabled: '#d1d5db',
      };

  // Recent addresses
  const { recentAddresses, addRecentAddress } = useRecentAddresses();

  // Saved locations from profile
  const [savedLocations, setSavedLocations] = useState<Array<{ label: string; address: string; latitude: number; longitude: number }>>([]);
  useEffect(() => {
    if (!user?.id) return;
    customerService.getProfile(user.id).then((p) => {
      if (p?.saved_locations?.length) {
        setSavedLocations(p.saved_locations.filter((l: any) => l.latitude && l.longitude));
      }
    }).catch(() => {});
  }, [user?.id]);

  // Balance
  const [balance, setBalance] = useState(0);
  useEffect(() => {
    if (!user?.id) return;
    walletService.getBalance(user.id).then((b) => setBalance(b.available)).catch(() => {});
  }, [user?.id]);

  // Location state
  const [pickup, setPickup] = useState<LocationPreset | null>(null);
  const [dropoff, setDropoff] = useState<LocationPreset | null>(null);
  const [pickupAddress, setPickupAddress] = useState('');
  const [dropoffAddress, setDropoffAddress] = useState('');
  const [selectionStep, setSelectionStep] = useState<WebSelectionStep>('pickup');

  // Ride state
  const [serviceType, setServiceType] = useState<ServiceTypeSlug>('triciclo_basico');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'tricicoin' | 'mixed'>('cash');

  /** Format fare price based on current payment method */
  const formatFare = useCallback((cupAmount: number, trcAmount?: number): string => {
    if (paymentMethod === 'tricicoin') {
      return formatTRC(trcAmount ?? cupAmount);
    }
    // For 'mixed' and 'cash', show CUP
    return formatCUP(cupAmount);
  }, [paymentMethod]);

  const [allEstimates, setAllEstimates] = useState<Record<string, any>>({});
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [deliveryVehicle, setDeliveryVehicle] = useState<ServiceTypeSlug>('moto_standard');

  // Route
  const [routeCoords, setRouteCoords] = useState<[number, number][]>([]);
  const [routeInfo, setRouteInfo] = useState<{ distance_m: number; duration_s: number } | null>(null);

  // Promo
  const [promoCode, setPromoCode] = useState('');
  const [promoResult, setPromoResult] = useState<{ valid: boolean; discount: number; promoId?: string; error?: string } | null>(null);
  const [promoValidating, setPromoValidating] = useState(false);

  // PASS #3 PROMO-STALE (web): clear a validated promo when the service type
  // changes — the discount was validated against the previous service's fare,
  // so leaving it would show a stale (possibly free-looking) price.
  useEffect(() => {
    setPromoResult(null);
  }, [serviceType]);

  // Schedule
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');

  // Delivery details
  const [deliveryName, setDeliveryName] = useState('');
  const [deliveryPhone, setDeliveryPhone] = useState('');
  const [deliveryCategory, setDeliveryCategory] = useState<PackageCategory>('paquete_pequeno');
  const [deliveryInstructions, setDeliveryInstructions] = useState('');
  const [clientAccompanies, setClientAccompanies] = useState(false);

  // Request state
  const [isRequesting, setIsRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestSuccess, setRequestSuccess] = useState(false);

  // Refs
  const dropoffInputRef = useRef<any>(null);
  const geoAttemptedRef = useRef(false);
  const mapViewRef = useRef<WebMapViewRef>(null);
  const centerDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const centerGeoIdRef = useRef(0); // Race condition guard for reverse geocode

  // Center pin reverse geocode state
  const [mapCenter, setMapCenter] = useState<{ lng: number; lat: number } | null>(null);
  const [centerAddress, setCenterAddress] = useState<string | null>(null);
  const [centerAddressLoading, setCenterAddressLoading] = useState(false);

  // Derived
  const selectedEstimate = serviceType === 'mensajeria' ? allEstimates[deliveryVehicle] : allEstimates[serviceType];
  const hasBothLocations = !!(pickup && dropoff);

  // Load route when both locations set
  useEffect(() => {
    if (!pickup || !dropoff) {
      setRouteCoords([]);
      setRouteInfo(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // QA 2026-05-13: fetchRoute moved from dynamic to static import (top of file).
        // Workspace package dynamic imports hang silently in --no-dev --minify.
        const result = await fetchRoute(
          { lat: pickup.latitude, lng: pickup.longitude },
          { lat: dropoff.latitude, lng: dropoff.longitude },
        );
        if (!cancelled && result) {
          setRouteCoords(result.coordinates);
          setRouteInfo({ distance_m: result.distance_m, duration_s: result.duration_s });
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [pickup?.latitude, pickup?.longitude, dropoff?.latitude, dropoff?.longitude]);

  // Auto-geolocation on first load
  useEffect(() => {
    if (geoAttemptedRef.current || pickup) return;
    geoAttemptedRef.current = true;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const loc = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        let address = 'Mi ubicación';
        try {
          const result = await reverseGeocode(loc.latitude, loc.longitude);
          if (result) address = result;
        } catch { /* fallback */ }
        // Only set if pickup hasn't been set by user in the meantime
        if (!pickup) {
          handleSetPickup({ address, latitude: loc.latitude, longitude: loc.longitude });
          // Fly map to user's location at street-level zoom
          mapViewRef.current?.flyTo(loc.longitude, loc.latitude, 16);
        }
      },
      () => { /* silently fail — user can manually enter */ },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, []);

  // Reverse geocode map center when panning (400ms debounce)
  // Supabase lookup is instant (~5-10ms), Overpass fallback if needed
  const handleCenterChanged = useCallback((center: { lng: number; lat: number }) => {
    setMapCenter(center);
    if (selectionStep === 'done') {
      setCenterAddress(null);
      return;
    }
    setCenterAddressLoading(true);
    const geoId = ++centerGeoIdRef.current;
    if (centerDebounceRef.current) clearTimeout(centerDebounceRef.current);
    centerDebounceRef.current = setTimeout(async () => {
      try {
        const addr = await reverseGeocode(center.lat, center.lng);
        // Only update if this is still the latest request (race condition guard)
        if (geoId !== centerGeoIdRef.current) return;
        setCenterAddress(addr);
      } catch {
        if (geoId !== centerGeoIdRef.current) return;
        setCenterAddress(null);
      } finally {
        if (geoId === centerGeoIdRef.current) setCenterAddressLoading(false);
      }
    }, 400);
  }, [selectionStep]);

  // Confirm center pin location as pickup or dropoff
  const handleConfirmCenter = useCallback(() => {
    if (!mapCenter || !centerAddress) return;
    const result = {
      address: centerAddress,
      latitude: mapCenter.lat,
      longitude: mapCenter.lng,
    };
    if (selectionStep === 'pickup') {
      handleSetPickup(result);
    } else if (selectionStep === 'dropoff') {
      handleSetDropoff(result);
    }
  }, [mapCenter, centerAddress, selectionStep]);

  // Auto-fetch estimates when both locations set
  const handleEstimateAll = useCallback(async () => {
    if (!pickup || !dropoff || estimateLoading) return;
    setEstimateLoading(true);
    setAllEstimates({});
    const serviceTypes: ServiceTypeSlug[] = ['triciclo_basico', 'moto_standard', 'auto_standard', 'auto_confort'];
    try {
      const results = await Promise.allSettled(
        serviceTypes.map((st) =>
          rideService.getLocalFareEstimate({
            pickup_lat: pickup.latitude,
            pickup_lng: pickup.longitude,
            dropoff_lat: dropoff.latitude,
            dropoff_lng: dropoff.longitude,
            service_type: st,
          }),
        ),
      );
      const estimates: Record<string, any> = {};
      serviceTypes.forEach((st, i) => {
        // Guard: `results[i]` is typed as possibly undefined under
        // noUncheckedIndexedAccess. Also narrow `r.value` access to the
        // fulfilled branch so TS sees `PromiseFulfilledResult<FareEstimate>`.
        const r = results[i];
        if (!r) { estimates[st] = null; return; }
        estimates[st] = r.status === 'fulfilled' ? r.value : null;
      });
      setAllEstimates(estimates);
    } catch { /* silent */ } finally {
      setEstimateLoading(false);
    }
  }, [pickup, dropoff, estimateLoading]);

  useEffect(() => {
    if (pickup && dropoff && Object.keys(allEstimates).length === 0 && !estimateLoading) {
      handleEstimateAll();
    }
  }, [pickup?.latitude, pickup?.longitude, dropoff?.latitude, dropoff?.longitude]);

  // Promo code handler
  const handleApplyPromo = async () => {
    const code = promoCode.trim();
    if (!code || !selectedEstimate) return;
    setPromoValidating(true);
    setPromoResult(null);
    try {
      const result = await rideService.validatePromoCode({
        code,
        userId: user?.id || '',
        fareAmount: selectedEstimate.estimated_fare_cup,
      });
      if (result.valid && result.promotion) {
        setPromoResult({ valid: true, promoId: result.promotion.id, discount: result.discountAmount });
      } else {
        const msgs: Record<string, string> = {
          invalid: t('ride.promo_error_invalid', { defaultValue: 'Código no válido' }),
          expired: t('ride.promo_error_expired', { defaultValue: 'Código expirado' }),
          max_uses: t('ride.promo_error_max_uses', { defaultValue: 'Código agotado' }),
          already_used: t('ride.promo_error_already_used', { defaultValue: 'Ya usaste este código' }),
          first_ride_only: t('ride.promo_error_first_ride', { defaultValue: 'Solo válido para tu primer viaje' }),
        };
        setPromoResult({ valid: false, discount: 0, error: msgs[result.error || 'invalid'] || t('ride.promo_error_invalid', { defaultValue: 'Código no válido' }) });
      }
    } catch {
      setPromoResult({ valid: false, discount: 0, error: 'Error al validar código' });
    } finally {
      setPromoValidating(false);
    }
  };

  // Request ride handler
  const handleRequest = async () => {
    if (!pickup || !dropoff || !selectedEstimate) return;

    // Validate TriciCoin balance
    if (paymentMethod === 'tricicoin') {
      const requiredAmount = selectedEstimate.estimated_fare_trc ?? selectedEstimate.estimated_fare_cup;
      // UX/bugfix: this used to reference `walletBalance`, which only
      // exists inside NativeHomeScreen / IdleView. In WebHomeScreen
      // the balance state is called `balance` (line 581). The mismatch
      // was a runtime ReferenceError hidden behind the TriciCoin
      // payment branch — any rider picking TriciCoin on web would crash
      // the Solicitar flow silently. Align to the real state.
      if (balance < requiredAmount) {
        router.push('/(tabs)/wallet');
        return;
      }
    }

    if (serviceType === 'mensajeria') {
      if (!deliveryName.trim()) { setError('Ingresa el nombre del destinatario'); return; }
      if (!deliveryPhone.trim() || !/^\+?[\d\s-]{6,}$/.test(deliveryPhone.trim())) { setError('Ingresa un teléfono válido'); return; }
    }
    setIsRequesting(true);
    setError(null);
    try {
      const activeSlug = serviceType === 'mensajeria' ? deliveryVehicle : serviceType;
      // Re-estimate to catch pricing changes
      let freshEstimate = selectedEstimate;
      try {
        const reEstimated = await rideService.getLocalFareEstimate({
          service_type: activeSlug,
          pickup_lat: pickup.latitude,
          pickup_lng: pickup.longitude,
          dropoff_lat: dropoff.latitude,
          dropoff_lng: dropoff.longitude,
        });
        setAllEstimates((prev) => ({ ...prev, [activeSlug]: reEstimated }));
        freshEstimate = reEstimated;
        const oldFare = selectedEstimate.estimated_fare_cup;
        const newFare = reEstimated.estimated_fare_cup;
        if (oldFare > 0 && Math.abs(newFare - oldFare) / oldFare > 0.05) {
          setError(`El precio se actualizó a ${newFare.toLocaleString()} CUP. Revisa y confirma de nuevo.`);
          setIsRequesting(false);
          return;
        }
      } catch { /* proceed with original */ }

      const ride = await rideService.createRide({
        service_type: activeSlug,
        payment_method: paymentMethod,
        pickup_latitude: pickup.latitude,
        pickup_longitude: pickup.longitude,
        pickup_address: pickupAddress || 'Origen',
        dropoff_latitude: dropoff.latitude,
        dropoff_longitude: dropoff.longitude,
        dropoff_address: dropoffAddress || 'Destino',
        estimated_fare_cup: freshEstimate.estimated_fare_cup,
        estimated_distance_m: freshEstimate.estimated_distance_m,
        estimated_duration_s: freshEstimate.estimated_duration_s,
        // BUG-fare-audit B1/L2: pasar el breakdown del estimate snapshot
        // (mismo patrón que useRide.confirmRide). createRide lo persiste
        // en `ride_pricing_snapshots` y el RPC lo lee al cobrar.
        base_fare_cup: freshEstimate.base_fare_cup,
        per_km_rate_cup: freshEstimate.per_km_rate_cup,
        per_minute_rate_cup: freshEstimate.per_minute_rate_cup,
        // BUG-fare-audit-followup Cambio 3: ver useRide.ts:609 para contexto.
        min_fare_cup: freshEstimate.min_fare_cup,
        surge_multiplier: freshEstimate.surge_multiplier,
        pricing_rule_id: freshEstimate.pricing_rule_id || undefined,
        ...(isScheduled && scheduleDate && { scheduled_at: new Date(scheduleDate).toISOString() }),
        ...(promoResult?.valid && promoResult.promoId && { promo_code_id: promoResult.promoId, discount_amount_cup: promoResult.discount }),
        ...(serviceType === 'mensajeria' && {
          ride_mode: 'cargo' as const,
          delivery_details: {
            recipient_name: deliveryName,
            recipient_phone: deliveryPhone,
            package_description: 'Paquete',
            package_category: deliveryCategory,
            special_instructions: deliveryInstructions || null,
            client_accompanies: clientAccompanies,
            delivery_vehicle_type: deliveryVehicle,
          },
        }),
      });
      // Store the ride and subscribe to realtime updates so status changes propagate
      useRideStore.getState().setActiveRide(ride);
      useRideStore.getState().setFlowStep('searching');

      // Subscribe to ride updates for status transitions (searching → accepted → etc)
      const channel = rideService.subscribeToRide(ride.id, (updated) => {
        useRideStore.getState().updateRideFromRealtime(updated);
      });
      // Store channel ref for cleanup (best-effort — cleanup on unmount handled by useRideInit)
      (window as any).__tricigo_web_ride_channel = channel;

      setRequestSuccess(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Not authenticated')) setError('Debes iniciar sesión.');
      else if (msg.includes('outside the service area')) setError('Ubicación fuera del área de servicio.');
      else setError(`Error: ${msg}`);
    } finally {
      setIsRequesting(false);
    }
  };

  // Pickup/dropoff handlers
  const handleSetPickup = (result: { address: string; latitude: number; longitude: number }) => {
    setPickup({ latitude: result.latitude, longitude: result.longitude, address: result.address });
    setPickupAddress(result.address);
    setAllEstimates({});
    setSelectionStep('dropoff');
    setCenterAddress(null);
    mapViewRef.current?.flyTo(result.longitude, result.latitude, 16);
    setTimeout(() => dropoffInputRef.current?.focus(), 100);
  };

  const handleSetDropoff = (result: { address: string; latitude: number; longitude: number }) => {
    setDropoff({ latitude: result.latitude, longitude: result.longitude, address: result.address });
    setDropoffAddress(result.address);
    setAllEstimates({});
    setSelectionStep('done');
    setCenterAddress(null);
    mapViewRef.current?.flyTo(result.longitude, result.latitude, 16);
  };

  const handleSwap = () => {
    const tmpP = pickup;
    const tmpPA = pickupAddress;
    setPickup(dropoff);
    setPickupAddress(dropoffAddress);
    setDropoff(tmpP);
    setDropoffAddress(tmpPA);
    setAllEstimates({});
  };

  const handleReset = () => {
    setPickup(null);
    setDropoff(null);
    setPickupAddress('');
    setDropoffAddress('');
    setSelectionStep('pickup');
    setAllEstimates({});
    setRouteCoords([]);
    setRouteInfo(null);
    setError(null);
    setRequestSuccess(false);
  };

  const handleUseMyLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const loc = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        let address = 'Mi ubicación';
        try {
          const result = await reverseGeocode(loc.latitude, loc.longitude);
          if (result) address = result;
        } catch { /* fallback */ }
        handleSetPickup({ address, latitude: loc.latitude, longitude: loc.longitude });
      },
      () => setError('No se pudo obtener tu ubicación'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  // Format CUP helper
  const fmtCUP = (cup: number) => `${Math.round(cup).toLocaleString('es-CU')} CUP`;
  const fmtPrice = (cupAmount: number, trcAmount?: number) =>
    paymentMethod === 'tricicoin' ? formatTRC(trcAmount ?? cupAmount) : fmtCUP(cupAmount);

  // ── Phase 5: Web active ride view ──
  const flowStep = useRideStore((s) => s.flowStep);

  // Reset requestSuccess when ride completes or is canceled
  useEffect(() => {
    if (requestSuccess && (flowStep === 'completed' || flowStep === 'idle')) {
      setRequestSuccess(false);
    }
  }, [flowStep, requestSuccess]);

  // Show completed view (rating)
  if (flowStep === 'completed') {
    return <WebActiveRideView onReset={handleReset} />;
  }

  if (flowStep === 'active') {
    return <WebActiveRideView onReset={handleReset} />;
  }

  // Success state — Premium searching UI
  if (requestSuccess) {
    return <WebSearchingState
      pickup={pickup}
      dropoff={dropoff}
      pickupAddress={pickupAddress}
      dropoffAddress={dropoffAddress}
      routeCoords={routeCoords}
      selectedEstimate={selectedEstimate}
      serviceType={serviceType}
      onReset={handleReset}
      font={font}
      paymentMethod={paymentMethod}
    />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <div style={{ display: 'flex', flexDirection: 'row', height: 'calc(100vh - 60px)', fontFamily: 'Montserrat, system-ui, sans-serif', background: c.bg }}>
        {/* ═══ LEFT SIDEBAR — Booking controls ═══ */}
        <div style={{
          width: 420, minWidth: 380, maxWidth: 460,
          display: 'flex', flexDirection: 'column',
          backgroundColor: c.panel, borderRight: `1px solid ${c.border}`,
          overflowY: 'auto',
        }}>
          <div style={{ padding: '24px 20px', flex: 1 }}>
            {/* Header */}
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 22, fontWeight: 800, color: c.text, margin: 0 }}>
                Solicita tu viaje
              </h2>
              <p style={{ fontSize: 13, color: c.textFaint, margin: '4px 0 0' }}>
                Selecciona origen y destino
              </p>
            </div>

            {/* Address inputs */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              <div style={{ position: 'relative', zIndex: 30 }}>
                <WebAddressInput
                  placeholder="Origen — ¿Dónde te recogemos?"
                  value={pickupAddress}
                  onSelect={handleSetPickup}
                  onClear={() => { setPickup(null); setPickupAddress(''); setAllEstimates({}); setSelectionStep('pickup'); }}
                  onFocus={() => setSelectionStep('pickup')}
                  icon={<View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#22c55e' }} />}
                  proximity={pickup}
                  autoFocus
                  savedLocations={savedLocations}
                  recentAddresses={recentAddresses}
                  onAddRecent={(a) => addRecentAddress(a.address, a.latitude, a.longitude)}
                />
              </div>

              {/* Swap button */}
              <div style={{ display: 'flex', justifyContent: 'center', margin: '-4px 0' }}>
                <Pressable onPress={handleSwap} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="swap-vertical" size={18} color={c.textMuted} />
                </Pressable>
              </div>

              <div style={{ position: 'relative', zIndex: 20 }}>
                <WebAddressInput
                  placeholder="Destino — ¿A dónde vas?"
                  value={dropoffAddress}
                  onSelect={handleSetDropoff}
                  onClear={() => { setDropoff(null); setDropoffAddress(''); setAllEstimates({}); setSelectionStep('dropoff'); }}
                  onFocus={() => setSelectionStep('dropoff')}
                  icon={<View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#ef4444' }} />}
                  proximity={pickup}
                  inputRef={dropoffInputRef}
                  savedLocations={savedLocations}
                  recentAddresses={recentAddresses}
                  onAddRecent={(a) => addRecentAddress(a.address, a.latitude, a.longitude)}
                />
              </div>
              {/* UX: first-time users (no recent/saved addresses) see two
                   silent text inputs and don't realize they autocomplete.
                   The WebAddressInput's dropdown only opens after they start
                   typing OR if they have history — neither is obvious on
                   day 1. A one-liner caption below the pair tells them
                   typing a street or landmark will bring up suggestions,
                   and quietly disappears once they've taken their first
                   ride and the history-driven dropdown takes over. */}
              {(savedLocations?.length ?? 0) === 0 && (recentAddresses?.length ?? 0) === 0 && (
                <p style={{ fontSize: 11, color: c.textFaint, marginTop: -4, marginBottom: 0, paddingLeft: 2 }}>
                  💡 Escribe una calle, esquina o lugar conocido — verás sugerencias al tipear.
                </p>
              )}
            </div>

            {/* Use my location button */}
            <Pressable onPress={handleUseMyLocation} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, marginBottom: 12 }}>
              <Ionicons name="locate" size={18} color={colors.brand.orange} />
              <Text style={{ fontSize: 13, color: colors.brand.orange, fontWeight: '600', marginLeft: 8, ...font }}>
                Usar mi ubicación
              </Text>
            </Pressable>

            {/* Location summary badges */}
            {(pickup || dropoff) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {pickup && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 20, backgroundColor: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)' }}>
                    <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e' }} />
                    <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 500, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {pickupAddress || 'Origen'}
                    </span>
                  </div>
                )}
                {dropoff && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 20, backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
                    <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444' }} />
                    <span style={{ fontSize: 12, color: '#dc2626', fontWeight: 500, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {dropoffAddress || 'Destino'}
                    </span>
                  </div>
                )}
                {hasBothLocations && (
                  <button onClick={handleReset} type="button" style={{ padding: '6px 12px', borderRadius: 20, border: `1px solid ${c.border}`, backgroundColor: c.panel, fontSize: 12, color: c.textMuted, cursor: 'pointer' }}>
                    Limpiar
                  </button>
                )}
              </div>
            )}

            {/* Route info */}
            {routeInfo && (
              <div style={{ display: 'flex', gap: 16, fontSize: 13, color: c.textMuted, marginBottom: 16, padding: '10px 14px', backgroundColor: c.surface, borderRadius: 10 }}>
                <span>📏 {(routeInfo.distance_m / 1000).toFixed(1)} km</span>
                <span>⏱ {Math.round(routeInfo.duration_s / 60)} min</span>
              </div>
            )}

            {/* ═══ Service cards ═══ */}
            <div style={{ marginBottom: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: c.textMuted, marginBottom: 8 }}>
                Elige tu servicio
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, opacity: hasBothLocations ? 1 : 0.5, pointerEvents: hasBothLocations ? 'auto' : 'none' }}>
                {WEB_SERVICES.map((svc) => {
                  const isMensajeria = svc.slug === 'mensajeria';
                  const est = isMensajeria ? allEstimates[deliveryVehicle] : allEstimates[svc.slug];
                  const isSelected = serviceType === svc.slug;
                  const isLoadingEst = estimateLoading && !est;

                  return (
                    <button
                      key={svc.slug}
                      type="button"
                      onClick={() => setServiceType(svc.slug)}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '12px 14px', borderRadius: 12,
                        border: isSelected ? '2px solid ' + colors.brand.orange : `1px solid ${c.border}`,
                        background: isSelected ? c.cardSel : c.panel,
                        cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <Image source={svc.img} style={{ width: 40, height: 40 }} resizeMode="contain" />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14, color: c.text }}>{svc.name}</div>
                          <div style={{ fontSize: 11, color: c.textFaint, marginTop: 2 }}>
                            {isMensajeria ? 'Según vehículo' : svc.desc}
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {isLoadingEst ? (
                          <div style={{ width: 60, height: 14, borderRadius: 4, background: c.surfaceAlt, animation: 'pulse 1.5s ease-in-out infinite' }} />
                        ) : est ? (
                          <>
                            <div style={{ fontWeight: 700, fontSize: 15, color: isSelected ? colors.brand.orange : c.text }}>
                              {fmtPrice(est.estimated_fare_cup, est.estimated_fare_trc)}
                            </div>
                            <div style={{ fontSize: 11, color: c.textFaint }}>
                              ~{Math.ceil((est.estimated_duration_s || 0) / 60)} min
                            </div>
                          </>
                        ) : (
                          /* UX: "—" was ambiguous — user couldn't tell if the
                             estimate was still loading or simply unavailable
                             for this service in the current zone. The
                             isLoadingEst branch above now owns the "loading"
                             state, so hitting this branch means we have a
                             definitive no-estimate answer. Say so. */
                          <div
                            title="Este servicio no está disponible para el trayecto seleccionado"
                            style={{ fontSize: 11, color: c.textFaint, fontStyle: 'italic' }}
                          >
                            No disponible
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ═══ Delivery form ═══ */}
            {serviceType === 'mensajeria' && (
              <div style={{ marginBottom: 16, padding: 16, borderRadius: 12, border: '2px solid ' + colors.brand.orange, background: isDark ? c.surface : 'linear-gradient(135deg, rgba(255,77,0,0.03), rgba(255,77,0,0.08))' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 20 }}>📦</span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: c.text }}>Datos del envío</div>
                    <div style={{ fontSize: 11, color: c.textFaint }}>Completa los datos del destinatario</div>
                  </div>
                </div>

                {/* Delivery vehicle selector */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: c.textMuted }}>Vehículo *</label>
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    {DELIVERY_VEHICLES.map((v) => {
                      const sel = deliveryVehicle === v.slug;
                      return (
                        <button key={v.slug} type="button" onClick={() => { setDeliveryVehicle(v.slug); setAllEstimates({}); }}
                          style={{ flex: 1, padding: '8px 6px', borderRadius: 10, border: sel ? '2px solid ' + colors.brand.orange : `1px solid ${c.border}`, background: sel ? c.cardSel : c.panel, cursor: 'pointer', textAlign: 'center' }}>
                          <Image source={v.img} style={{ width: 28, height: 28, marginBottom: 2 }} resizeMode="contain" />
                          <div style={{ fontSize: 11, fontWeight: sel ? 700 : 500, color: sel ? colors.brand.orange : c.textMuted }}>{v.label}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Recipient name */}
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: c.textMuted }}>Destinatario *</label>
                  <input type="text" value={deliveryName} onChange={(e) => setDeliveryName(e.target.value)} placeholder="Nombre completo"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${c.border}`, fontSize: 13, marginTop: 4, boxSizing: 'border-box', outline: 'none', background: c.inputBg, color: c.text }} />
                </div>

                {/* Recipient phone */}
                {(() => {
                  // UX: phone format errors used to surface only when the
                  // user hit "Solicitar" — by then they had typed 5 other
                  // fields and the feedback felt punitive. Live-validate
                  // the format (+DD DDDDDDDD minimum) so they see the red
                  // border and helper as they type, not after.
                  const phoneDigits = deliveryPhone.replace(/\s/g, '');
                  const phoneLooksValid = phoneDigits === '' || /^\+\d{8,15}$/.test(phoneDigits);
                  const phoneShowError = deliveryPhone.length > 0 && !phoneLooksValid;
                  return (
                    <div style={{ marginBottom: 8 }}>
                      <label style={{ fontSize: 12, fontWeight: 600, color: c.textMuted }}>Teléfono *</label>
                      <input type="tel" value={deliveryPhone} onChange={(e) => setDeliveryPhone(e.target.value)} placeholder="+53 5XXXXXXX o 6XXXXXXX"
                        style={{
                          width: '100%', padding: '8px 10px', borderRadius: 8,
                          border: phoneShowError ? '1px solid #ef4444' : `1px solid ${c.border}`,
                          fontSize: 13, marginTop: 4, boxSizing: 'border-box', outline: 'none',
                          background: c.inputBg, color: c.text,
                        }} />
                      {phoneShowError && (
                        <p style={{ fontSize: 11, color: isDark ? '#fca5a5' : '#b91c1c', marginTop: 4 }}>
                          Usa formato internacional con +: ej. +5356622516
                        </p>
                      )}
                    </div>
                  );
                })()}

                {/* Package category */}
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: c.textMuted }}>Tipo de paquete</label>
                  <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                    {DELIVERY_CATS.map((cat) => {
                      const sel = deliveryCategory === cat.value;
                      return (
                        <button key={cat.value} type="button" onClick={() => setDeliveryCategory(cat.value)}
                          style={{ padding: '6px 10px', borderRadius: 8, border: sel ? '2px solid ' + colors.brand.orange : `1px solid ${c.border}`, background: sel ? c.cardSel : c.panel, cursor: 'pointer', fontSize: 12, color: c.text }}>
                          {cat.icon} {cat.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Instructions */}
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: c.textMuted }}>Instrucciones</label>
                  <input type="text" value={deliveryInstructions} onChange={(e) => setDeliveryInstructions(e.target.value)} placeholder="Instrucciones especiales"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${c.border}`, fontSize: 13, marginTop: 4, boxSizing: 'border-box', outline: 'none', background: c.inputBg, color: c.text }} />
                </div>

                {/* Client accompanies toggle */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: c.text }}>
                  <input type="checkbox" checked={clientAccompanies} onChange={(e) => setClientAccompanies(e.target.checked)} />
                  <span style={{ fontWeight: 500 }}>Voy con el envío</span>
                </label>
              </div>
            )}

            {/* ═══ Fare estimate card ═══ */}
            <div style={{
              padding: 16, borderRadius: 12, marginBottom: 16,
              border: selectedEstimate ? '2px solid ' + colors.brand.orange : `1px solid ${c.border}`,
              background: selectedEstimate ? c.cardSel : c.panel,
              opacity: selectedEstimate ? 1 : 0.6,
            }}>
              {!selectedEstimate && (
                <p style={{ textAlign: 'center', fontSize: 13, color: c.textFaint, margin: 0, padding: '8px 0' }}>
                  Selecciona origen y destino para ver el estimado
                </p>
              )}
              {selectedEstimate && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontSize: 13, color: c.textMuted }}>Tarifa estimada</span>
                    <div style={{ textAlign: 'right' }}>
                      {promoResult?.valid && promoResult.discount > 0 ? (
                        <>
                          <span style={{ fontSize: 15, fontWeight: 600, color: c.textFaint, textDecoration: 'line-through', marginRight: 8 }}>
                            {fmtPrice(selectedEstimate.estimated_fare_cup, selectedEstimate.estimated_fare_trc)}
                          </span>
                          <span style={{ fontSize: 22, fontWeight: 800, color: '#22c55e' }}>
                            {fmtPrice(Math.max(selectedEstimate.estimated_fare_cup - promoResult.discount, 0))}
                          </span>
                        </>
                      ) : (
                        <span style={{ fontSize: 22, fontWeight: 800, color: colors.brand.orange }}>
                          {fmtPrice(selectedEstimate.estimated_fare_cup, selectedEstimate.estimated_fare_trc)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 12, fontSize: 12, color: c.textMuted, flexWrap: 'wrap' }}>
                    <span>{((selectedEstimate.estimated_distance_m || 0) / 1000).toFixed(1)} km</span>
                    <span>{Math.round((selectedEstimate.estimated_duration_s || 0) / 60)} min</span>
                    <span style={{ color: c.textFaint }}>~${((selectedEstimate.estimated_fare_cup || 0) / (selectedEstimate.exchange_rate_usd_cup || 300)).toFixed(2)} USD</span>
                  </div>
                  {(selectedEstimate.surge_multiplier || 0) > 1 && (
                    <span style={{ display: 'inline-block', marginTop: 8, color: '#fff', background: colors.brand.orange, fontWeight: 700, padding: '2px 10px', borderRadius: 12, fontSize: 11 }}>
                      {selectedEstimate.surge_multiplier.toFixed(1)}x · mal tiempo
                    </span>
                  )}

                  {/* Payment method */}
                  <div style={{ marginTop: 14 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6, color: c.text }}>Método de pago</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {(['cash', 'tricicoin', 'mixed'] as const).map((pm) => {
                        const sel = paymentMethod === pm;
                        return (
                          <button key={pm} type="button" onClick={() => setPaymentMethod(pm)}
                            style={{ flex: 1, padding: '8px', borderRadius: 8, border: sel ? '2px solid ' + colors.brand.orange : `1px solid ${c.border}`, background: sel ? c.cardSel : c.panel, cursor: 'pointer', fontSize: 13, fontWeight: sel ? 700 : 400, color: sel ? colors.brand.orange : c.text }}>
                            {pm === 'cash' ? 'Efectivo' : pm === 'tricicoin' ? 'TriciCoin' : 'Mixto'}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* ═══ Promo code ═══ */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: c.textMuted }}>Código promocional</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <input
                  type="text"
                  value={promoCode}
                  onChange={(e) => { setPromoCode(e.target.value.toUpperCase()); setPromoResult(null); }}
                  placeholder="Ingresa un código"
                  disabled={promoResult?.valid === true}
                  style={{
                    flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', outline: 'none',
                    color: c.text,
                    border: promoResult?.valid ? '2px solid #22c55e' : promoResult?.valid === false ? '2px solid #ef4444' : `1px solid ${c.border}`,
                    background: promoResult?.valid ? 'rgba(34,197,94,0.08)' : c.inputBg,
                  }}
                />
                {promoResult?.valid ? (
                  <button type="button" onClick={() => { setPromoCode(''); setPromoResult(null); }}
                    style={{ padding: '8px 14px', borderRadius: 8, border: `1px solid ${c.border}`, background: c.panel, fontSize: 13, cursor: 'pointer', color: c.textMuted }}>
                    Quitar
                  </button>
                ) : (
                  <button type="button" onClick={handleApplyPromo}
                    disabled={!promoCode.trim() || !selectedEstimate || promoValidating}
                    style={{
                      padding: '8px 16px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      cursor: (!promoCode.trim() || !selectedEstimate || promoValidating) ? 'not-allowed' : 'pointer',
                      background: (!promoCode.trim() || !selectedEstimate || promoValidating) ? c.disabled : colors.brand.orange,
                      color: '#fff',
                    }}>
                    {/* UX: text-only 'Validando...' was static; the server call
                         takes 1–3s on Cuba's connection, and a dormant button
                         feels broken. Pair the text with a rotating glyph so
                         the user gets clear visual motion during the wait. */}
                    {promoValidating && (
                      <span
                        aria-hidden
                        style={{
                          width: 10, height: 10, borderRadius: '50%',
                          border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff',
                          animation: 'pulse 0.8s linear infinite',
                          display: 'inline-block',
                        }}
                      />
                    )}
                    {promoValidating ? 'Validando...' : 'Aplicar'}
                  </button>
                )}
              </div>
              {promoResult && (
                <p style={{ fontSize: 12, marginTop: 4, color: promoResult.valid ? '#22c55e' : '#ef4444' }}>
                  {promoResult.valid ? `Descuento: -${fmtPrice(promoResult.discount)}` : promoResult.error}
                </p>
              )}
            </div>

            {/* ═══ Schedule toggle ═══ */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={isScheduled} onChange={(e) => { setIsScheduled(e.target.checked); if (!e.target.checked) setScheduleDate(''); }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: c.text }}>Programar viaje</span>
              </label>
              {isScheduled && (
                <input
                  type="datetime-local"
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
                  min={new Date().toISOString().slice(0, 16)}
                  style={{ width: '100%', marginTop: 8, padding: '8px 10px', borderRadius: 8, border: `1px solid ${c.border}`, fontSize: 13, boxSizing: 'border-box', background: c.inputBg, color: c.text, colorScheme: isDark ? 'dark' : 'light' }}
                />
              )}
            </div>

            {/* Error */}
            {error && (
              /* UX: plain-text error got lost between the promo + schedule
                   rows on a tall panel. A muted red banner reads fine for
                   sighted users but blends in; the alert glyph anchors the
                   eye to the problem, and the close button gives the user
                   an explicit way to dismiss (useful when they fix the
                   cause themselves — e.g., retype the address — and the
                   stale message is now irrelevant). */
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                fontSize: 13, color: isDark ? '#fca5a5' : '#b91c1c', marginBottom: 12, padding: '10px 12px',
                backgroundColor: isDark ? 'rgba(239,68,68,0.14)' : 'rgba(239,68,68,0.06)', borderRadius: 8,
                border: '1px solid rgba(239,68,68,0.25)',
              }}>
                <span style={{ fontSize: 16, lineHeight: '18px' }} aria-hidden>⚠</span>
                <span style={{ flex: 1, lineHeight: '18px' }}>{error}</span>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  aria-label="Cerrar error"
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: isDark ? '#fca5a5' : '#b91c1c', fontSize: 14, padding: 0, lineHeight: '18px',
                  }}
                >
                  ✕
                </button>
              </div>
            )}

            {/* ═══ Request button ═══ */}
            <button
              type="button"
              onClick={handleRequest}
              disabled={isRequesting || !selectedEstimate}
              style={{
                width: '100%', padding: 14, borderRadius: 12, border: 'none',
                background: (!selectedEstimate || isRequesting) ? c.disabled : colors.brand.orange,
                color: '#fff', fontSize: 15, fontWeight: 700,
                cursor: (!selectedEstimate || isRequesting) ? 'not-allowed' : 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {isRequesting
                ? 'Solicitando...'
                : selectedEstimate
                  ? `Solicitar ${WEB_SERVICES.find((s) => s.slug === serviceType)?.name || ''} · ${fmtPrice(
                      promoResult?.valid ? Math.max(selectedEstimate.estimated_fare_cup - (promoResult.discount || 0), 0) : selectedEstimate.estimated_fare_cup,
                      promoResult?.valid ? undefined : selectedEstimate.estimated_fare_trc,
                    )}`
                : 'Solicitar viaje'}
            </button>
          </div>

          {/* Balance footer */}
          <div style={{
            padding: '14px 20px', borderTop: `1px solid ${c.border}`,
            background: 'linear-gradient(135deg, #FF4D00, #FF8A5C)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontWeight: 500 }}>TriciCoin</span>
            <span style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>{formatTRC(balance)}</span>
          </div>
        </div>

        {/* ═══ RIGHT SIDE — Map ═══ */}
        <div style={{ flex: 1, position: 'relative' }}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
            <WebMapView
              ref={mapViewRef}
              center={pickup ? [pickup.longitude, pickup.latitude] : [-82.38, 23.13]}
              zoom={16}
              interactive={true}
              pickup={pickup}
              dropoff={dropoff}
              routeCoords={routeCoords}
              showCenterPin={selectionStep !== 'done'}
              onCenterChanged={handleCenterChanged}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as any}
            />
          </div>

          {/* Center address bar — shows when panning map during selection */}
          {selectionStep !== 'done' && (centerAddress || centerAddressLoading) && (
            <div style={{
              position: 'absolute',
              bottom: 24,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 16px',
              backgroundColor: '#fff',
              borderRadius: 12,
              boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
              maxWidth: '80%',
              zIndex: 20,
              fontFamily: 'Montserrat, system-ui, sans-serif',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {centerAddressLoading ? (
                  <span style={{ fontSize: 13, color: '#9ca3af' }}>Buscando dirección...</span>
                ) : (
                  <span style={{ fontSize: 13, color: '#1a1a1a', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                    {centerAddress}
                  </span>
                )}
                <span style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, display: 'block' }}>
                  {selectionStep === 'pickup' ? 'Punto de recogida' : 'Punto de destino'}
                </span>
              </div>
              {centerAddress && !centerAddressLoading && (
                <button
                  type="button"
                  onClick={handleConfirmCenter}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 8,
                    border: 'none',
                    backgroundColor: colors.brand.orange,
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Confirmar
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </View>
  );
}

function NativeHomeScreen() {
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);
  // Needed by the coupon banner in the ride-in-progress branch below. IdleView
  // derives its own from the same store; this call has to sit above the early
  // returns because hooks cannot run conditionally.
  const tokens = useTokens();

  // BUG-253 (Capa 3.1): useRideInit moved up to app/_layout.tsx so the
  // watcher stays alive across tab navigations. Removed from here to
  // avoid running it twice and creating duplicate channels.

  // Share rider location during pickup phase (G1)
  useRiderLocationSharing();

  const flowStep = useRideStore((s) => s.flowStep);
  const draft = useRideStore((s) => s.draft);
  const setPickup = useRideStore((s) => s.setPickup);
  const setDropoff = useRideStore((s) => s.setDropoff);
  const updateWaypoint = useRideStore((s) => s.updateWaypoint);
  const [mapPickerMode, setMapPickerMode] = useState<'pickup' | 'dropoff' | 'waypoint' | null>(null);

  // BUG-253 (Capa 3.5): if the flow transitions away from 'idle'/'selecting'
  // while a picker overlay is open, force-close it. Without this, the
  // local picker state can outlive its valid lifecycle and re-render
  // on top of a pinned activeRide ("phantom" symptom).
  useEffect(() => {
    if (flowStep !== 'idle' && flowStep !== 'selecting' && mapPickerMode !== null) {
      setMapPickerMode(null);
    }
  }, [flowStep, mapPickerMode]);

  // Crossfade animation between flow steps
  const flowFadeAnim = useRef(new Animated.Value(1)).current;
  const prevFlowStepRef = useRef(flowStep);

  useEffect(() => {
    if (prevFlowStepRef.current !== flowStep) {
      prevFlowStepRef.current = flowStep;
      const sequence = Animated.sequence([
        Animated.timing(flowFadeAnim, { toValue: 0, duration: 150, useNativeDriver: true }),
        Animated.timing(flowFadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]);
      sequence.start();
      return () => sequence.stop();
    }
  }, [flowStep, flowFadeAnim]);

  // Onboarding overlay — shows once on first app launch
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem('@tricigo/onboarding_completed').then((v) => {
      if (!v) setShowOnboarding(true);
    });
  }, []);

  // SelectingView renders fullscreen (no scroll) for map background
  if (flowStep === 'selecting') {
    // Render ONLY the map picker when active to avoid two Mapbox MapView
    // instances fighting for gestures on Android (caused frozen pan/zoom).
    if (mapPickerMode) {
      const lastWaypoint = draft.waypoints.length > 0 ? draft.waypoints[draft.waypoints.length - 1] : null;
      // BUG-282 — fallback chain so the picker doesn't open at HAVANA_CENTER
      // (= São Paulo in demo mode) when the slot is empty for the first time:
      //   pickup picker  → draft.pickup ?? draft.dropoff (no useful fallback otherwise)
      //   dropoff picker → draft.dropoff ?? draft.pickup (start near the user)
      //   waypoint picker → last waypoint ?? draft.pickup
      const pickerInitialLoc =
        mapPickerMode === 'pickup'
          ? draft.pickup?.location ?? null
          : mapPickerMode === 'waypoint'
            ? lastWaypoint?.location ?? draft.pickup?.location ?? null
            : draft.dropoff?.location ?? draft.pickup?.location ?? null;
      return (
        <View style={{ flex: 1 }}>
          <ConfirmLocationScreen
            mode={mapPickerMode === 'waypoint' ? 'dropoff' : mapPickerMode}
            initialLocation={pickerInitialLoc}
            onConfirm={(address, location) => {
              if (!isValidCoordinate(location.latitude, location.longitude)) { setMapPickerMode(null); return; }
              if (mapPickerMode === 'pickup') {
                setPickup(address, location);
              } else if (mapPickerMode === 'waypoint') {
                const wpIdx = draft.waypoints.length - 1;
                if (wpIdx >= 0) updateWaypoint(wpIdx, address, location);
              } else {
                setDropoff(address, location);
              }
              setMapPickerMode(null);
            }}
            onClose={() => setMapPickerMode(null)}
          />
        </View>
      );
    }
    return <SelectingView setMapPickerMode={setMapPickerMode} />;
  }

  // Other non-idle flow steps use Screen with scroll
  // BUG-230: in 'active' state the page contains a Mapbox MapView. A
  // parent ScrollView intercepts vertical drag gestures, leaving the user
  // only horizontal pan on the map. RideActiveView already handles its
  // own scrolling internally for the post-map content, so we disable
  // the outer Screen scroll for that flow only.
  if (flowStep !== 'idle') {
    const enableScroll = flowStep !== 'active';
    return (
      <>
        <Screen bg="cuban" padded scroll={enableScroll}>
          {/* ── Cupón activo ── the SECOND of the banner's two mount points.
              A passenger who closes the ticket and books another ride has the
              home replaced by this branch; without a mount here their live
              coupon becomes unreachable while its two-hour clock runs down.
              Deliberately OUTSIDE the Animated.View so it does not blink on
              every flow-step crossfade. Renders null when there is no coupon.

              'searching' matters as much as 'active' here, and is easy to miss:
              since the staged-radius dispatch in 00525 a passenger can sit in
              searching for several minutes, and that is dead time in which the
              clock runs but the coupon cannot be reached.

              'reviewing' and 'completed' are deliberately excluded — the first
              is a short, focused confirm step where a stray tap would abandon
              the fare the passenger is reading, and the second already shows
              the whole ticket. */}
          {(flowStep === 'active' || flowStep === 'searching') && (
            <PartnerCouponBanner tokens={tokens} compact />
          )}
          <Animated.View style={{ opacity: flowFadeAnim, flex: 1 }}>
            {flowStep === 'reviewing' && <ReviewingView />}
            {flowStep === 'searching' && <SearchingView />}
            {flowStep === 'active' && <RideActiveView />}
            {flowStep === 'completed' && <RideCompleteView />}
          </Animated.View>
          {showOnboarding && (
            <OnboardingOverlay
              onComplete={() => {
                setShowOnboarding(false);
                AsyncStorage.setItem('@tricigo/onboarding_completed', 'true');
              }}
            />
          )}
        </Screen>
        {/* BUG-253 (Capa 3.3): the location-picker overlay was previously
            rendered HERE while flowStep was 'searching'/'active'/etc. That
            allowed the user to mutate pickup/dropoff while a ride was
            already pinned, producing the "phantom ride" symptom (draft
            diverged from DB row). The picker now only renders inside the
            'selecting' branch (above) and is force-closed when flowStep
            transitions away from 'idle'/'selecting' (see useEffect on
            mapPickerMode + flowStep). No overlay here. */}
      </>
    );
  }

  // Idle: Uber-style fullscreen map layout
  return (
    <View style={{ flex: 1, backgroundColor: '#f5f5f5' }}>
      <Animated.View style={{ opacity: flowFadeAnim, flex: 1 }}>
        <IdleView />
      </Animated.View>
      {/* Notification permission prompt (shows once on first visit) */}
      <NotificationPermissionSheet />
      {/* Update-available prompt (shows when a newer store version exists) */}
      <UpdateAvailableSheet />
      {/* Onboarding tutorial (shows once on first app launch) */}
      {showOnboarding && (
        <OnboardingOverlay
          onComplete={() => {
            setShowOnboarding(false);
            AsyncStorage.setItem('@tricigo/onboarding_completed', 'true');
          }}
        />
      )}
    </View>
  );
}

// ── Idle View ──────────────────────────────────────────────

function IdleView() {
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);
  const draft = useRideStore((s) => s.draft);
  const setFlowStep = useRideStore((s) => s.setFlowStep);
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const setMode = useThemeStore((s) => s.setMode);
  const mode: 'light' | 'dark' = resolvedScheme;
  const tokens = mode === 'dark' ? cubanDark : cubanLight;
  const setDropoff = useRideStore((s) => s.setDropoff);
  const setPickup = useRideStore((s) => s.setPickup);
  const prefetchedPickup = useRideStore((s) => s.prefetchedPickup);
  const setPrefetchedPickup = useRideStore((s) => s.setPrefetchedPickup);
  // Sticky-serviceType fix: setServiceType fixes the slug the user tapped in
  // SERVICIOS; resetServiceSelection normalizes destination-based entries back
  // to passenger so a prior mensajería order never leaks into a normal trip.
  const setServiceType = useRideStore((s) => s.setServiceType);
  const resetServiceSelection = useRideStore((s) => s.resetServiceSelection);
  const { requestEstimate } = useRideActions();
  const [locationDenied, setLocationDenied] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [userCenter, setUserCenter] = useState<[number, number] | null>(null);
  const userLocationSet = useRef(false);
  const [walletBalance, setWalletBalance] = useState(0);
  // BUG-wallet-desync Cambio 4: usar exchange rate live en lugar del
  // hardcode /500 del BalanceHeroCard. Si el fetch falla, mantiene 500
  // (comportamiento previo) → sin regresión.
  const [usdCupRate, setUsdCupRate] = useState(500);
  // Home content feed — promotions + blog posts + campañas shown on idle view
  // (after recents, before services). See docs/superpowers/specs/
  // 2026-04-29-home-content-cards-design.md.
  const [activePromos, setActivePromos] = useState<ActivePromotion[]>([]);
  const [blogPosts, setBlogPosts] = useState<BlogPost[]>([]);
  const [announcements, setAnnouncements] = useState<HomeAnnouncement[]>([]);
  // Last completed ride — re-engagement card (¿Volver a [destino]?)
  const [lastRide, setLastRide] = useState<{
    id: string;
    pickup_address: string;
    dropoff_address: string;
    pickup_location: { latitude: number; longitude: number } | null;
    dropoff_location: { latitude: number; longitude: number } | null;
    created_at: string;
  } | null>(null);
  const { recentAddresses } = useRecentAddresses();
  const { predictions } = useDestinationPredictions();
  const { data: weather } = useWeather(
    userCenter ? { latitude: userCenter[1], longitude: userCenter[0] } : null,
  );
  const notifCenterEnabled = useFeatureFlag('notification_center_enabled');
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const setUnreadCount = useNotificationStore((s) => s.setUnreadCount);
  const incrementUnread = useNotificationStore((s) => s.incrementUnread);

  // Check location permission + pre-fetch pickup address on mount
  useEffect(() => {
    let cancelled = false;

    // Instant fallback: load cached position from AsyncStorage while GPS resolves
    AsyncStorage.getItem('last_known_location').then((cached) => {
      if (cached && !cancelled) {
        try {
          const { latitude, longitude } = JSON.parse(cached);
          if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            setUserCenter([longitude, latitude]);
          }
        } catch { /* ignore malformed cache */ }
      }
    }).catch(() => {});

    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setLocationDenied(true);
          return;
        }
        // Try cached position first, fall back to fresh GPS
        let pos = await Location.getLastKnownPositionAsync();
        if (!pos) {
          pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        }
        if (!pos || cancelled) return;

        // Wait for GPS to stabilize — skip geocoding if accuracy > 100m
        const accuracy = pos.coords.accuracy ?? 999;
        if (accuracy > 100) {
          // Try fresh GPS with higher accuracy
          try {
            const freshPos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
            if (freshPos && (freshPos.coords.accuracy ?? 999) < 100) pos = freshPos;
          } catch { /* use what we have */ }
        }
        if (cancelled) return;

        const loc = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };

        // Cache for future cold starts
        AsyncStorage.setItem('last_known_location', JSON.stringify(loc)).catch(() => {});

        // Center map immediately even before geocoding finishes
        if (!cancelled) setUserCenter([pos.coords.longitude, pos.coords.latitude]);

        // Show placeholder while geocoding resolves
        const placeholder = t('home.detecting_address', { defaultValue: 'Detectando dirección...' });
        if (!cancelled) {
          setPrefetchedPickup({ address: placeholder, location: loc });
          setPickup(placeholder, loc);
        }

        // Retry geocoding up to 3 times (Mapbox can fail on cold start)
        let resolvedAddress: string | null = null;
        for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 1000));
          if (cancelled) break;
          try {
            resolvedAddress = await reverseGeocode(loc.latitude, loc.longitude);
            if (resolvedAddress) break;
          } catch { /* continue to next attempt */ }
        }

        if (!cancelled) {
          const finalAddress = resolvedAddress || `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`;
          setPrefetchedPickup({ address: finalAddress, location: loc });
          setPickup(finalAddress, loc);
        }
      } catch {
        // Silently ignore — don't crash
      }
    })();
    return () => { cancelled = true; };
  }, [setPrefetchedPickup, setPickup]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        await walletService.ensureAccount(user.id);
        const bal = await walletService.getBalance(user.id);
        if (!cancelled) setWalletBalance(bal.available);
      } catch (err) { logger.warn('Failed to load wallet', { error: String(err) }); }
      // BUG-wallet-desync Cambio 4: traer exchange rate vigente para
      // que el USD mostrado debajo del balance refleje el rate real
      // (antes hardcoded /500). Best-effort: si falla, queda el default 500.
      try {
        const rate = await exchangeRateService.getUsdCupRate();
        if (!cancelled && rate > 0) setUsdCupRate(rate);
      } catch { /* best-effort, queda en 500 */ }
      if (!cancelled) setInitialLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // The home tab stays mounted, so the [user?.id] effect above only runs once.
  // Refetch the balance whenever the home regains focus (e.g. returning from
  // /wallet) and when the app comes back to the foreground — otherwise an
  // external credit (admin top-up, gift, ride payment) doesn't show on the home
  // card until a full app restart, while the wallet screen (which refetches on
  // focus) shows it correctly.
  const refetchBalance = useCallback(() => {
    if (!user?.id) return;
    walletService.getBalance(user.id).then((b) => setWalletBalance(b.available)).catch(() => {});
  }, [user?.id]);

  useFocusEffect(refetchBalance);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refetchBalance();
    });
    return () => sub.remove();
  }, [refetchBalance]);

  // Fetch home content feed — active promotions + recent blog posts.
  // Both are best-effort; failures are silent (the home stays usable
  // without these sections). Fires once on mount, no realtime updates
  // (idle content doesn't change often enough to justify a subscription).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // The promotions table is admin-only under RLS (00321) — a direct
        // .from('promotions') read returns 0 rows for customers, which kept
        // this section permanently hidden. The SECURITY DEFINER RPC exposes
        // only marketing-safe fields (mig 00476); [] when not yet deployed.
        const promos = await promotionService.getActivePromotions(6);
        if (!cancelled) setActivePromos(promos);
      } catch (err) {
        logger.warn('Failed to load promotions feed', { error: String(err) });
      }

      try {
        const posts = await blogService.getPublishedPosts(0, 6);
        if (!cancelled) setBlogPosts(posts);
      } catch (err) {
        logger.warn('Failed to load blog feed', { error: String(err) });
      }

      try {
        // RLS already filters out inactive/expired rows.
        const items = await announcementService.getActive(null, 6);
        if (!cancelled) setAnnouncements(items);
      } catch (err) {
        logger.warn('Failed to load announcements feed', { error: String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Last ride — fetch the most recent COMPLETED trip so we can show a
  // "¿Volver a [destino]?" card. Re-engagement pattern from Uber Eats:
  // most repeat trips are to the same handful of destinations, so a
  // 1-tap shortcut to the last drop-off saves the user from typing.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await rideService.getRideHistoryFiltered({
          userId: user.id,
          page: 0,
          pageSize: 1,
          status: ['completed'],
        });
        if (cancelled || !data || data.length === 0) return;
        const ride = data[0];
        if (!ride) return;
        setLastRide({
          id: ride.id,
          pickup_address: ride.pickup_address ?? '',
          dropoff_address: ride.dropoff_address ?? '',
          pickup_location: ride.pickup_location,
          dropoff_location: ride.dropoff_location,
          created_at: ride.created_at,
        });
      } catch (err) {
        logger.warn('Failed to load last ride', { error: String(err) });
      }
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

  // U2.1: Live driver availability pulse
  const [driverCount, setDriverCount] = useState<number | null>(null);

  useEffect(() => {
    const fetchDriverCount = async () => {
      try {
        // BUG-123: switched from .from('driver_profiles').select('*', count) to
        // a SECURITY DEFINER RPC. The previous direct table query relied on
        // dp_select_own's public clause that exposed identity_number, address
        // and criminal_record_details to every authenticated user; that clause
        // is now gone, and this RPC returns just an integer.
        const { data } = await getSupabaseClient()
          .rpc('count_online_drivers', { p_within_minutes: 5 });
        setDriverCount(typeof data === 'number' ? data : 0);
      } catch {
        setDriverCount(0);
      }
    };
    fetchDriverCount();
    const interval = setInterval(fetchDriverCount, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleRecentTap = useCallback((addr: { address: string; latitude: number; longitude: number }) => {
    setDropoff(addr.address, { latitude: addr.latitude, longitude: addr.longitude });
    resetServiceSelection(); // passenger trip — never inherit a stuck mensajería mode
    setFlowStep('selecting');
  }, [setDropoff, resetServiceSelection, setFlowStep]);

  // U1.1: One-tap booking — set pickup (current location) + dropoff, jump to estimate → selecting
  const handleOneTapPrediction = useCallback(async (pred: PredictedDestination) => {
    try {
      // Use prefetched pickup if available (instant, no GPS wait)
      if (prefetchedPickup) {
        setPickup(prefetchedPickup.address, prefetchedPickup.location);
        setDropoff(pred.address, { latitude: pred.latitude, longitude: pred.longitude });
        resetServiceSelection(); // passenger trip — never inherit a stuck mensajería mode
        setFlowStep('selecting');
        return;
      }

      // Fallback: try GPS
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') {
        handleRecentTap({ address: pred.address, latitude: pred.latitude, longitude: pred.longitude });
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const pickupAddress = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
      setPickup(
        pickupAddress ?? `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`,
        { latitude: pos.coords.latitude, longitude: pos.coords.longitude },
      );
      setDropoff(pred.address, { latitude: pred.latitude, longitude: pred.longitude });
      resetServiceSelection(); // passenger trip — never inherit a stuck mensajería mode
      setFlowStep('selecting');
    } catch {
      // Fallback: just go to selecting view with dropoff only
      handleRecentTap({ address: pred.address, latitude: pred.latitude, longitude: pred.longitude });
    }
  }, [handleRecentTap, setPickup, setDropoff, resetServiceSelection, setFlowStep, prefetchedPickup]);

  const insets = useSafeAreaInsets();

  if (initialLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: tokens.bg.paper }}>
        <View style={{ flex: 1, backgroundColor: tokens.bg.elev2 }} />
        <View style={[idleStyles.bottomPanel, { backgroundColor: tokens.bg.elev1 }]}>
          <Skeleton width="60%" height={28} style={{ marginBottom: 12 }} />
          <Skeleton width="100%" height={52} style={{ borderRadius: 12, marginBottom: 12 }} />
          <SkeletonCard />
        </View>
      </View>
    );
  }

  // ── Recent places for the new home ──
  // Build a map from id → raw address so the onSelect handler can look up coords
  const recentAddressById = new Map<string, typeof recentAddresses[number]>();
  const recentPlaces = recentAddresses.slice(0, 3).map((ra, i) => {
    const id = `recent-${i}-${ra.timestamp}`;
    recentAddressById.set(id, ra);
    const ago = Date.now() - (ra.timestamp ?? 0);
    const hoursAgo = Math.floor(ago / (60 * 60 * 1000));
    const when =
      hoursAgo < 1
        ? t('home.just_now', { defaultValue: 'Hace un rato' })
        : hoursAgo < 24
          ? t('home.hours_ago', { defaultValue: `Hace ${hoursAgo}h`, hours: hoursAgo })
          : hoursAgo < 48
            ? t('home.yesterday', { defaultValue: 'Ayer' })
            : t('home.days_ago', { defaultValue: `Hace ${Math.floor(hoursAgo / 24)}d`, days: Math.floor(hoursAgo / 24) });
    return { id, name: ra.address, when };
  });

  const handleRecentSelect = (p: { id: string }) => {
    const raw = recentAddressById.get(p.id);
    if (!raw) return;
    // Auto-fill pickup if we have the prefetched current location —
    // one-tap-book behavior, same as handleOneTapPrediction.
    if (prefetchedPickup) {
      setPickup(prefetchedPickup.address, prefetchedPickup.location);
    }
    setDropoff(raw.address, { latitude: raw.latitude, longitude: raw.longitude });
    resetServiceSelection(); // passenger trip — never inherit a stuck mensajería mode
    // Go to `selecting` (mapa + vehicle picker) — NOT `reviewing`, which
    // would render null because fareEstimate is still null until the
    // selecting view triggers handleEstimateAll().
    setFlowStep('selecting');
  };

  const greetingName = (user?.full_name ?? 'Viajero').split(' ')[0] ?? 'Viajero';
  const initial = greetingName.charAt(0).toUpperCase();

  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg.paper }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 8,
          paddingHorizontal: 20,
          paddingBottom: 120,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Top bar ── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
            <Text style={{ fontFamily: 'BricolageGrotesque_700Bold', fontSize: 20, letterSpacing: -0.5, color: tokens.ink.primary }}>
              Trici
            </Text>
            <Text style={{ fontFamily: 'BricolageGrotesque_700Bold', fontSize: 20, letterSpacing: -0.5, color: tokens.accent.orange }}>
              Go
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            {/* Weather chip — hides when no data; uses GPS-resolved coords */}
            {weather && (
              <WeatherChip
                tempC={weather.tempC}
                conditionCode={weather.conditionCode}
                city={weather.city}
                mode={mode}
              />
            )}
            {/* Theme toggle */}
            <Pressable
              onPress={() => setMode(mode === 'dark' ? 'light' : 'dark')}
              style={{
                width: 36, height: 36, borderRadius: 18,
                backgroundColor: tokens.bg.elev1,
                borderWidth: 1, borderColor: tokens.line,
                alignItems: 'center', justifyContent: 'center',
              }}
              accessibilityRole="button"
              accessibilityLabel={t('home.toggle_theme', { defaultValue: 'Cambiar tema' })}
            >
              <Ionicons
                name={mode === 'dark' ? 'sunny-outline' : 'moon-outline'}
                size={16}
                color={tokens.ink.primary}
              />
            </Pressable>
            {/* Notifications */}
            {notifCenterEnabled && (
              <Pressable
                onPress={() => router.push('/notifications')}
                style={{
                  width: 36, height: 36, borderRadius: 18,
                  backgroundColor: tokens.bg.elev1,
                  borderWidth: 1, borderColor: tokens.line,
                  alignItems: 'center', justifyContent: 'center',
                }}
                accessibilityRole="button"
                accessibilityLabel={t('notifications.title')}
              >
                <Ionicons name={unreadCount > 0 ? 'notifications' : 'notifications-outline'} size={16} color={tokens.ink.primary} />
                {unreadCount > 0 && (
                  <View style={{ position: 'absolute', top: 8, right: 8, width: 7, height: 7, borderRadius: 4, backgroundColor: tokens.accent.orange }} />
                )}
              </Pressable>
            )}
            {/* Avatar */}
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: tokens.accent.orange, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontFamily: 'BricolageGrotesque_700Bold', fontSize: 15, color: '#FFFBF5' }}>
                {initial}
              </Text>
            </View>
          </View>
        </View>

        {/* ── Location-denied banner ── */}
        {locationDenied && (
          <Pressable
            onPress={async () => {
              const { status } = await Location.requestForegroundPermissionsAsync();
              if (status === 'granted') setLocationDenied(false);
            }}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 8,
              padding: 12, marginBottom: 14, borderRadius: 12,
              backgroundColor: mode === 'dark' ? 'rgba(255,181,71,0.14)' : '#FEF3C7',
            }}
          >
            <Ionicons name="location-outline" size={18} color={tokens.accent.warm} />
            <Text style={{ flex: 1, fontFamily: 'Inter_500Medium', fontSize: 13, color: tokens.ink.primary }}>
              {t('home.location_denied_title', { defaultValue: 'Activa tu ubicación para encontrar viajes' })}
            </Text>
          </Pressable>
        )}

        {/* ── Cupón activo ── the FIRST of the banner's two mount points, the
            other being the ride-in-progress branch of NativeHomeScreen. Sits
            above the balance and the address search because it is the only
            thing on this screen with a deadline: two hours from arrival and
            it is gone. Renders null when there is no live coupon, so it costs
            the layout nothing the rest of the time. */}
        <PartnerCouponBanner tokens={tokens} />

        {/* ── Balance ── */}
        <BalanceHeroCard
          balanceTc={walletBalance}
          balanceUsd={walletBalance / usdCupRate}
          mode={mode}
          label={t('home.balance_label', { defaultValue: 'Saldo disponible' })}
          // '/wallet' does not exist — apps/client/app/wallet/ only holds
          // gift.tsx, so this landed on +not-found. The `as never` cast was
          // silencing the typed-route error that would have caught it.
          onPress={() => router.push('/(tabs)/wallet')}
        />

        {/* ── Destination ask ── */}
        <View style={{ marginTop: 28 }}>
          <DisplayHeading mode={mode}>
            {t('home.where_to_cuban', { defaultValue: '¿A dónde vamos hoy?' })}
          </DisplayHeading>
          <Pressable
            onPress={() => { resetServiceSelection(); setFlowStep('selecting'); }}
            style={{
              marginTop: 14,
              flexDirection: 'row', alignItems: 'center', gap: 12,
              backgroundColor: tokens.bg.elev1,
              borderRadius: 999,
              borderWidth: 1, borderColor: tokens.line,
              paddingHorizontal: 18, paddingVertical: 14,
            }}
            accessibilityRole="search"
            accessibilityLabel={t('home.where_to')}
          >
            <Ionicons name="search" size={20} color={tokens.accent.orange} />
            <Text style={{ flex: 1, fontFamily: 'Inter_500Medium', fontSize: 15, color: tokens.ink.secondary }}>
              {t('home.search_placeholder_cuban', { defaultValue: 'Buscar dirección o lugar…' })}
            </Text>
          </Pressable>
        </View>

        {/* ── Split invites inline (existing feature) ── */}
        <View style={{ marginTop: 12 }}>
          <SplitInviteCard />
        </View>

        {/* ── Recientes ── */}
        {recentPlaces.length > 0 && (
          <View style={{ marginTop: 24 }}>
            <Text style={{ fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 10, letterSpacing: 2, color: tokens.ink.subtle, marginBottom: 8 }}>
              {t('home.recents_label', { defaultValue: 'RECIENTES' })}
            </Text>
            <RecentPlacesList
              places={recentPlaces}
              onSelect={handleRecentSelect}
              mode={mode}
            />
          </View>
        )}

        {/* ── Tu último viaje ── 1-tap re-book of the last completed trip */}
        {lastRide && lastRide.dropoff_address && lastRide.dropoff_location && (
          <View style={{ marginTop: 24 }}>
            <Text style={{ fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 10, letterSpacing: 2, color: tokens.ink.subtle, marginBottom: 8 }}>
              {t('home.last_ride_label', { defaultValue: 'TU ÚLTIMO VIAJE' })}
            </Text>
            <Pressable
              onPress={() => {
                if (!lastRide.dropoff_location) return;
                triggerHaptic('light');
                setDropoff(lastRide.dropoff_address, lastRide.dropoff_location);
                resetServiceSelection(); // passenger trip — never inherit a stuck mensajería mode
                setFlowStep('selecting');
              }}
              style={{
                backgroundColor: tokens.bg.elev1,
                borderColor: tokens.line,
                borderWidth: 1,
                borderRadius: 16,
                padding: 14,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
              }}
              accessibilityRole="button"
              accessibilityLabel={t('home.last_ride_a11y', {
                defaultValue: `Volver a ${lastRide.dropoff_address}`,
                address: lastRide.dropoff_address,
              })}
            >
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 999,
                  backgroundColor: tokens.accent.orangeGlow,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="repeat" size={20} color={tokens.accent.orange} />
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    fontFamily: 'Inter',
                    fontSize: 13,
                    color: tokens.ink.subtle,
                    marginBottom: 2,
                  }}
                >
                  {t('home.go_back_to', { defaultValue: '¿Volver a' })}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{
                    fontFamily: 'Inter',
                    fontSize: 15,
                    fontWeight: '600',
                    color: tokens.ink.primary,
                  }}
                >
                  {lastRide.dropoff_address}?
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={tokens.ink.subtle} />
            </Pressable>
          </View>
        )}

        {/* ── Capitolio divider (Cuban identity marker) ── */}
        <CapitolioDivider mode={mode} height={72} />

        {/* ── Lugares con beneficio ── partner places near the passenger.
            Sits ABOVE Promos deliberately. This is the surface a partner
            business is given in exchange for absorbing a free coffee, so
            burying it as the fourth horizontal card row would make the deal
            worth little and the "hero card" treatment pointless. It costs
            TriciGo's own ride promos one position.

            Renders nothing without a fix or without a place in range.
            `userCenter` is a GeoJSON [longitude, latitude] tuple — the same
            state that centres the map and feeds useWeather, reused here to
            avoid a second location subscription. Note the order: [1] is
            latitude. A swap type-checks cleanly, both members being numbers,
            so it would fail silently. */}
        <PartnerPlacesCarousel
          latitude={userCenter?.[1] ?? null}
          longitude={userCenter?.[0] ?? null}
          tokens={tokens}
          onSelect={(place) => {
            setDropoff(place.name, { latitude: place.latitude, longitude: place.longitude });
            resetServiceSelection(); // passenger trip — never inherit a stuck mensajería mode
            setFlowStep('selecting');
          }}
        />

        {/* ── Promos ── horizontal scroll of active promotions */}
        {activePromos.length > 0 && (
          <View style={{ marginTop: 24 }}>
            <Text style={{ fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 10, letterSpacing: 2, color: tokens.ink.subtle, marginBottom: 8 }}>
              {t('home.promos_label', { defaultValue: 'PROMOS' })}
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 10, paddingRight: 16 }}
            >
              {activePromos.map((promo) => {
                // Marketing copy (title_es) wins when the admin filled it;
                // otherwise synthesize a headline from discount_percent /
                // discount_fixed_cup (whole CUP, applied directly by
                // validate_promo_code — NOT centavos).
                const headline = promo.title_es
                  || (promo.discount_percent
                    ? `${promo.discount_percent}% OFF`
                    : promo.discount_fixed_cup
                      ? `${promo.discount_fixed_cup} CUP`
                      : '🎁');
                const expiry = promo.valid_until
                  ? new Date(promo.valid_until).toLocaleDateString('es', { day: 'numeric', month: 'short' })
                  : null;
                return (
                  <Pressable
                    key={promo.id}
                    onPress={() => {
                      // Prefill the promo into the booking flow (the booking
                      // promo field reads useRideStore.promoCode). Was wrongly
                      // routing to /profile/referral (unrelated to promos).
                      useRideStore.getState().setPromoCode(promo.code);
                      triggerSelection();
                      Alert.alert(
                        t('home.promo_ready_title', { defaultValue: 'Código listo' }),
                        t('home.promo_ready_body', {
                          defaultValue: 'Aplicamos "{{code}}" a tu próxima reserva. Verifícalo en el campo de código promocional.',
                          code: promo.code,
                        }),
                      );
                    }}
                    style={{
                      width: 220,
                      backgroundColor: tokens.bg.elev1,
                      borderColor: tokens.accent.orange,
                      borderWidth: 1,
                      borderRadius: 16,
                      padding: 14,
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Promo ${promo.code}: ${headline}`}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                      <View
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 999,
                          backgroundColor: tokens.accent.orangeGlow,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Ionicons name="pricetag" size={14} color={tokens.accent.orange} />
                      </View>
                      <Text
                        style={{
                          fontFamily: 'JetBrainsMono_500Medium',
                          fontSize: 11,
                          color: tokens.ink.subtle,
                          letterSpacing: 0.5,
                        }}
                      >
                        {promo.code}
                      </Text>
                    </View>
                    <Text
                      style={{
                        fontFamily: 'BricolageGrotesque_700Bold',
                        fontSize: 22,
                        color: tokens.accent.orange,
                        marginBottom: 4,
                      }}
                    >
                      {headline}
                    </Text>
                    {expiry && (
                      <Text
                        style={{
                          fontFamily: 'JetBrainsMono_400Regular',
                          fontSize: 10,
                          color: tokens.ink.subtle,
                          letterSpacing: 0.5,
                        }}
                      >
                        {t('home.promo_expires', { defaultValue: `Hasta ${expiry}`, date: expiry })}
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        )}

        {/* ── Campañas (announcements) ── curated content cards from admin */}
        {announcements.length > 0 && (
          <View style={{ marginTop: 24 }}>
            <Text style={{ fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 10, letterSpacing: 2, color: tokens.ink.subtle, marginBottom: 8 }}>
              {t('home.campaigns_label', { defaultValue: 'CAMPAÑAS' })}
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 10, paddingRight: 16 }}
            >
              {announcements.map((a) => {
                const handlePress = () => {
                  // Resolve cta_url through the shared resolver so a value like
                  // '/book' (a web-only route) starts the in-app booking flow
                  // instead of router.push'ing a non-existent route → 404.
                  const action = resolveAnnouncementCta(a.cta_url);
                  switch (action.kind) {
                    case 'book':
                      // '/(tabs)?service=mensajeria' → preselect mensajería;
                      // plain '/(tabs)' → normal trip (don't inherit a stuck mode).
                      if (action.service) setServiceType(action.service);
                      else resetServiceSelection();
                      setFlowStep('selecting');
                      break;
                    case 'route':
                      router.push(action.path as never);
                      break;
                    case 'external':
                      // tricigo://, https://, mailto:, tel: → system handler
                      Linking.openURL(action.url).catch(() => {
                        // dead link — best-effort, ignore silently
                      });
                      break;
                    case 'none':
                      break; // empty or unrecognised path → no-op (never 404)
                  }
                };
                return (
                  <Pressable
                    key={a.id}
                    onPress={handlePress}
                    style={{
                      width: 260,
                      backgroundColor: tokens.bg.elev1,
                      borderColor: tokens.line,
                      borderWidth: 1,
                      borderRadius: 16,
                      overflow: 'hidden',
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={a.title_es}
                  >
                    {a.image_url ? (
                      <Image
                        source={{ uri: a.image_url }}
                        style={{ width: '100%', height: 110 }}
                        resizeMode="cover"
                      />
                    ) : (
                      <View
                        style={{
                          width: '100%',
                          height: 110,
                          backgroundColor: tokens.bg.elev2,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Ionicons name="megaphone-outline" size={32} color={tokens.accent.orange} />
                      </View>
                    )}
                    <View style={{ padding: 12 }}>
                      <Text
                        numberOfLines={2}
                        style={{
                          fontFamily: 'BricolageGrotesque_700Bold',
                          fontSize: 14,
                          color: tokens.ink.primary,
                          marginBottom: 4,
                          lineHeight: 18,
                        }}
                      >
                        {a.title_es}
                      </Text>
                      {a.body_es && (
                        <Text
                          numberOfLines={2}
                          style={{
                            fontFamily: 'Inter',
                            fontSize: 11,
                            color: tokens.ink.subtle,
                            lineHeight: 14,
                            marginBottom: a.cta_label_es ? 8 : 0,
                          }}
                        >
                          {a.body_es}
                        </Text>
                      )}
                      {a.cta_label_es && a.cta_url && (
                        <View
                          style={{
                            alignSelf: 'flex-start',
                            paddingHorizontal: 10,
                            paddingVertical: 4,
                            borderRadius: 999,
                            backgroundColor: tokens.accent.orange,
                          }}
                        >
                          <Text
                            style={{
                              fontFamily: 'JetBrainsMono_600SemiBold',
                              fontSize: 10,
                              letterSpacing: 0.5,
                              color: '#FFFBF5',
                            }}
                          >
                            {a.cta_label_es.toUpperCase()}
                          </Text>
                        </View>
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        )}

        {/* ── Novedades (blog) ── horizontal scroll of recent posts */}
        {blogPosts.length > 0 && (
          <View style={{ marginTop: 24 }}>
            <Text style={{ fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 10, letterSpacing: 2, color: tokens.ink.subtle, marginBottom: 8 }}>
              {t('home.news_label', { defaultValue: 'NOVEDADES' })}
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 10, paddingRight: 16 }}
            >
              {blogPosts.map((post) => (
                <Pressable
                  key={post.id}
                  onPress={() => router.push('/profile/blog')}
                  style={{
                    width: 240,
                    backgroundColor: tokens.bg.elev1,
                    borderColor: tokens.line,
                    borderWidth: 1,
                    borderRadius: 16,
                    overflow: 'hidden',
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={post.title_es}
                >
                  {post.cover_image_url ? (
                    <Image
                      source={{ uri: post.cover_image_url }}
                      style={{ width: '100%', height: 100 }}
                      resizeMode="cover"
                    />
                  ) : (
                    // Fallback gradient when no cover — uses brand orange.
                    <View
                      style={{
                        width: '100%',
                        height: 100,
                        backgroundColor: tokens.bg.elev2,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Ionicons name="newspaper-outline" size={28} color={tokens.ink.subtle} />
                    </View>
                  )}
                  <View style={{ padding: 12 }}>
                    <Text
                      numberOfLines={2}
                      style={{
                        fontFamily: 'BricolageGrotesque_600SemiBold',
                        fontSize: 14,
                        color: tokens.ink.primary,
                        marginBottom: 4,
                        lineHeight: 18,
                      }}
                    >
                      {post.title_es}
                    </Text>
                    {post.excerpt_es && (
                      <Text
                        numberOfLines={2}
                        style={{
                          fontFamily: 'Inter',
                          fontSize: 11,
                          color: tokens.ink.subtle,
                          lineHeight: 14,
                        }}
                      >
                        {post.excerpt_es}
                      </Text>
                    )}
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

        {/* ── Servicios — 5 en fila ── */}
        <Text style={{ fontFamily: 'JetBrainsMono_600SemiBold', fontSize: 10, letterSpacing: 2, color: tokens.ink.subtle, marginBottom: 10 }}>
          {t('home.services_label', { defaultValue: 'SERVICIOS' })}
        </Text>
        <View style={{ flexDirection: 'row', gap: 7 }}>
          {(['triciclo_basico', 'moto_standard', 'auto_standard', 'auto_confort', 'mensajeria'] as const).map((slug) => (
            <ServiceIconButton
              key={slug}
              icon={vehicleSelectionImages[slug]}
              name={t(`service_type.${slug}` as const, { defaultValue: slug.split('_')[0]!.charAt(0).toUpperCase() + slug.split('_')[0]!.slice(1) })}
              dense
              mode={mode}
              onPress={() => {
                // Preselect the tapped service type, then go to selecting view.
                // Sticky-serviceType fix: this was missing, so every SERVICIOS
                // button just opened SelectingView with whatever serviceType was
                // left over (e.g. a previous mensajería order). Now the tapped
                // slug is the source of truth.
                setServiceType(slug);
                setFlowStep('selecting');
              }}
            />
          ))}
        </View>

        {/* ── Driver count chip (subtle) ── */}
        {driverCount !== null && driverCount > 0 && (
          <View style={{ marginTop: 20, flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: tokens.bg.elev1, borderWidth: 1, borderColor: tokens.line }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#22C55E' }} />
            <Text style={{ fontFamily: 'JetBrainsMono_500Medium', fontSize: 11, color: tokens.ink.secondary }}>
              {t('home.drivers_active_short', { defaultValue: `${driverCount} conductores activos`, count: driverCount })}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ── IdleView Styles (Uber-style fullscreen map) ──
const idleStyles = StyleSheet.create({
  searchBarContainer: {
    position: 'absolute',
    left: 16,
    right: 60,
    zIndex: 10,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 6,
  },
  notifBell: {
    position: 'absolute',
    right: 16,
    zIndex: 10,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 4,
  },
  notifBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#EF4444',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  driverBadge: {
    position: 'absolute',
    right: 16,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  locationBanner: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(254,243,199,0.95)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
  bottomPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 10,
  },
  predictionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginRight: 10,
    width: 200,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  predictionIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FFF7ED',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
});

// X2.4: Geocoding coordinate validation
function isValidCoordinate(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
}

// UBER-1.1: Recommend a service based on distance + passengers
function getRecommendedService(distanceM: number, passengers: number): ServiceTypeSlug {
  if (passengers > 2) return 'triciclo_basico';
  if (distanceM < 3000) return 'moto_standard';
  if (distanceM < 8000) return 'auto_standard';
  return 'auto_confort';
}

// UBER-1.2: Format currency with thousand separators
function formatCurrency(amount: number): string {
  return Math.round(amount).toLocaleString('es-CU');
}

// UBER-1.1: Service metadata for recommendation cards
const SERVICE_META: Record<string, { label: string; desc: string; maxPax: number; slug: ServiceTypeSlug }> = {
  moto_standard: { label: 'Moto', desc: 'Rápido', maxPax: 1, slug: 'moto_standard' },
  triciclo_basico: { label: 'Triciclo', desc: 'Económico', maxPax: 3, slug: 'triciclo_basico' },
  auto_standard: { label: 'Auto', desc: 'Cómodo', maxPax: 4, slug: 'auto_standard' },
  auto_confort: { label: 'Confort', desc: 'Premium', maxPax: 4, slug: 'auto_confort' },
  mensajeria: { label: 'Envío', desc: 'Delivery', maxPax: 0, slug: 'mensajeria' },
};

// Vehicle selection icons (used in service cards)
const VEHICLE_ICONS: Record<string, any> = {
  moto_standard: require('../../assets/vehicles/selection/moto.png'),
  triciclo_basico: require('../../assets/vehicles/selection/triciclo.png'),
  // TODO: dedicated side-view almendrón selection asset still pending.
  // markers/auto_clasico.png is top-down style — looked wrong in the
  // selection card (per user QA 2026-05-13). Using selection/auto.png
  // (modern sedan side-view) until a proper almendrón selection asset
  // lands. Map markers continue using auto_clasico.png correctly.
  auto_standard: require('../../assets/vehicles/selection/auto.png'),
  auto_confort: require('../../assets/vehicles/selection/confort.png'),
  mensajeria: require('../../assets/vehicles/selection/mensajeria.png'),
};

// ── Selecting View ─────────────────────────────────────────

// The `waypoint` variant is the same one added to searchingField so
// the waypoint-search map-picker flow can be wired later. Keeps the
// two types aligned (same setter accepts the same values).
function SelectingView({ setMapPickerMode }: { setMapPickerMode: (mode: 'pickup' | 'dropoff' | 'waypoint' | null) => void }) {
  // BUG-282 (revised) — initial map center.
  // Two-stage resolution: (1) AsyncStorage cache for an instant first
  // frame, (2) fresh GPS fix that overrides the cache once it arrives.
  // Without (2), a first-ever install (empty cache) or a stale cache
  // would leave the map stuck at the demo fallback (São Paulo) even
  // when the user is somewhere else (e.g. Foz do Iguaçu). The Camera's
  // `key` prop in RideMapView remounts cleanly on each update.
  const [userCenter, setUserCenter] = useState<[number, number] | null>(null);
  useEffect(() => {
    let cancelled = false;

    // Stage 1: instant read from cache (no GPS hardware wait)
    AsyncStorage.getItem('last_known_location').then((cached) => {
      if (cancelled || !cached) return;
      try {
        const { latitude, longitude } = JSON.parse(cached);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          setUserCenter([longitude, latitude]);
        }
      } catch { /* malformed */ }
    }).catch(() => {});

    // Stage 2: fresh GPS — gives the truth even on first install or
    // after the user moved cities. Permission was already requested
    // in IdleView; we only call the position APIs (no permission UI
    // re-prompt here).
    (async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.status !== 'granted' || cancelled) return;
        // Cheapest first: last known native fix (instant if any app
        // touched GPS recently). Then fall back to a fresh fix.
        let pos = await Location.getLastKnownPositionAsync();
        if (!pos) {
          pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
        }
        if (!pos || cancelled) return;
        const lng = pos.coords.longitude;
        const lat = pos.coords.latitude;
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
        setUserCenter([lng, lat]);
        // Refresh cache so any sibling/subsequent view also benefits.
        AsyncStorage.setItem(
          'last_known_location',
          JSON.stringify({ latitude: lat, longitude: lng }),
        ).catch(() => {});
      } catch { /* silently fall back to cache */ }
    })();

    return () => { cancelled = true; };
  }, []);
  const { t, i18n } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const mode: 'light' | 'dark' = resolvedScheme;
  const tokens = mode === 'dark' ? cubanDark : cubanLight;
  const {
    draft,
    prefetchedPickup,
    allFareEstimates,
    setPickup,
    setDropoff,
    swapPickupDropoff,
    setServiceType,
    setPaymentMethod,
    setDeliveryField,
    setPassengerCount,
    setShareRide,
    setCorporateAccount,
    setWalletRatio,
    setFlowStep,
    resetDraft,
    addWaypoint,
    removeWaypoint,
    updateWaypoint,
    isLoading,
    isFareEstimating,
    error,
    promoCode,
    promoResult,
    setPromoCode,
    fareEstimate,
  } = useRideStore();
  const { requestEstimate, confirmRide, validatePromo, validatingPromo } = useRideActions();
  const { recentAddresses } = useRecentAddresses();
  const { predictions } = useDestinationPredictions();
  const { accounts: corporateAccounts } = useCorporateAccounts();
  const debouncedConfirmRide = useDebouncePress(() => { triggerHaptic('medium'); confirmRide(); });
  const insets = useSafeAreaInsets();
  const waypointPoints = useMemo(
    () => draft.waypoints
      .filter((w): w is { address: string; location: NonNullable<typeof w.location> } => w.address !== '' && w.location !== null)
      .map((w) => ({ latitude: w.location.latitude, longitude: w.location.longitude })),
    [draft.waypoints],
  );
  const { coordinates: routeCoordinates, distanceM: routeDistanceM, durationS: routeDurationS } = useRoutePolyline(draft.pickup?.location, draft.dropoff?.location, waypointPoints);
  // Memoized lat/lng form of the user center — consumed by SubmitPoiSheet
  // (defaults the "report a place" form to where the user is standing).
  const userCenterLatLng = useMemo(
    () => (userCenter ? { latitude: userCenter[1], longitude: userCenter[0] } : null),
    [userCenter],
  );

  // ── Which vehicles can actually carry this package ──
  // Dispatch filters cargo offers fail-closed on accepts_cargo, weight and
  // category (00326 wired up by 00512). A rider who picks a vehicle that
  // cannot take their package gets ZERO offers and a ride that searches until
  // the stale-ride watchdog cancels it — with nothing on screen saying why.
  // These specs are the ones the form already collects; no extra fields are
  // asked of the rider.
  const deliverySpecs = useMemo(
    () => ({
      weightKg: draft.delivery.estimatedWeightKg ? parseFloat(draft.delivery.estimatedWeightKg) : undefined,
      category: draft.delivery.packageCategory ?? undefined,
    }),
    [draft.delivery.estimatedWeightKg, draft.delivery.packageCategory],
  );
  const { options: deliveryVehicleOptions } = useDeliveryVehicles(deliverySpecs);
  const deliveryReasonLang: 'es' | 'en' | 'pt' =
    i18n.language?.startsWith('en') ? 'en' : i18n.language?.startsWith('pt') ? 'pt' : 'es';

  // Changing the weight or category can invalidate a vehicle already chosen.
  // Leaving it selected would let the rider book a delivery nobody can accept,
  // so the selection is cleared and they are asked to pick again.
  const selectedDeliveryOption = draft.delivery.deliveryVehicleType
    ? deliveryVehicleOptions.find((o) => o.type === draft.delivery.deliveryVehicleType)
    : undefined;
  useEffect(() => {
    if (selectedDeliveryOption && !selectedDeliveryOption.compatibility.compatible) {
      setDeliveryField('deliveryVehicleType', null);
    }
  }, [selectedDeliveryOption, setDeliveryField]);

  const deliveryBlockedNote = useMemo(() => {
    const blocked = deliveryVehicleOptions.filter((o) => !o.compatibility.compatible);
    if (blocked.length === 0) return null;
    if (blocked.length === deliveryVehicleOptions.length) {
      return t('delivery.no_vehicle_fits', {
        defaultValue: 'Ningún vehículo puede llevar este paquete. Revisa el peso o la categoría.',
      });
    }
    const first = blocked[0]!;
    const label = ({ moto: 'Moto', triciclo: 'Triciclo', auto: 'Auto', confort: 'Confort' } as const)[first.type];
    const reason = INCOMPATIBILITY_REASON_LABELS[first.compatibility.reason ?? '']?.[deliveryReasonLang];
    return reason ? `${label}: ${reason.toLowerCase()}` : null;
  }, [deliveryVehicleOptions, deliveryReasonLang, t]);

  // Compute selectedEstimate from allFareEstimates for the current service type.
  // Mensajería se cobra al precio del VEHÍCULO elegido (alinea con la web): resuelve
  // al slug del vehículo en vez del config plano de 'mensajeria'.
  const selectedEstimateSlug =
    draft.serviceType === 'mensajeria' && draft.delivery.deliveryVehicleType
      ? deliveryVehicleToSlug(draft.delivery.deliveryVehicleType)
      : draft.serviceType;
  const selectedEstimate = allFareEstimates?.[selectedEstimateSlug] ?? null;

  // Live discount preview (promo + "Compartir viaje"). Mirrors the
  // server-side trigger 00347 exactly so the shown fare = what the server
  // will charge: shareDiscount = floor(gross × freeSeats × 7%), freeSeats =
  // cap − occupied with occupied clamped to [1, cap−1]. passengerCount does
  // NOT trigger a re-estimate, so gross stays stable while only the overlay
  // changes. The server is still authoritative; this is just the preview.
  const SHARE_PCT = 7;
  const grossCup = selectedEstimate?.estimated_fare_cup ?? 0;
  const shareOcc = Math.min(Math.max(draft.passengerCount || 1, 1), 3);
  const shareFreeSeats = (draft.serviceType === 'triciclo_basico' && draft.shareRide) ? (4 - shareOcc) : 0;
  const shareDiscountCup = Math.floor((grossCup * shareFreeSeats * SHARE_PCT) / 100);
  const promoDiscountCup = promoResult?.valid ? (promoResult.discountAmount ?? 0) : 0;
  const totalDiscountCup = Math.min(promoDiscountCup + shareDiscountCup, grossCup);
  const netCup = Math.max(0, grossCup - totalDiscountCup);
  const netTrc = (selectedEstimate?.estimated_fare_trc != null && grossCup > 0)
    ? Math.round(selectedEstimate.estimated_fare_trc * (netCup / grossCup))
    : selectedEstimate?.estimated_fare_trc;

  // "Compartir viaje" toggle. When enabling sharing on a tricycle, clamp the
  // passenger count into the nested stepper's range (1–3) so the single visible
  // control never shows an out-of-range value carried over from another service.
  const handleShareRideToggle = (val: boolean) => {
    setShareRide(val);
    if (val && draft.serviceType === 'triciclo_basico' && (draft.passengerCount || 1) > 3) {
      setPassengerCount(3);
    }
  };

  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>([]);
  // Includes 'waypoint' to match the existing UI branches that
  // handle stop-search. The setter for 'waypoint' isn't wired yet
  // (waypoints are added from a different entry point), but the
  // branches are ready for when it is — keeping the type union
  // aligned lets those code paths live without dead-comparison
  // warnings, and keeps the search UI future-proof.
  const [searchingField, setSearchingField] = useState<'pickup' | 'dropoff' | 'waypoint' | null>(null);
  const [pickupSuggestion, setPickupSuggestion] = useState<{
    latitude: number; longitude: number; address: string;
  } | null>(null);

  // Crowdsourcing — "Sugerir lugar" sheet visibility + snapshotted coords.
  // PR 3 of POI parity program. Coords default to user's location; we
  // could enhance later to use long-press on the map for "agregar aquí".
  const [submitPoiOpen, setSubmitPoiOpen] = useState(false);
  const submitPoiCoords = userCenterLatLng;

  /** Format fare based on payment method */
  const formatFare = useCallback((cupAmount: number, trcAmount?: number): string => {
    if (draft.paymentMethod === 'tricicoin') {
      return formatTRC(trcAmount ?? cupAmount);
    }
    return formatCUP(cupAmount);
  }, [draft.paymentMethod]);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [selectingDetailsExpanded, setSelectingDetailsExpanded] = useState(false);
  const [promoExpanded, setPromoExpanded] = useState(false);
  const [walletBalance, setWalletBalance] = useState(0);

  // Fetch wallet balance for mixed payment ratio selector
  useEffect(() => {
    if (!user?.id) return;
    walletService.getBalance(user.id).then((b) => setWalletBalance(b.available ?? 0)).catch(() => {});
  }, [user?.id]);

  // Nearest driver ETA
  const nearbyVehicles = useNearbyVehicles(
    draft.pickup?.location?.latitude,
    draft.pickup?.location?.longitude,
  );

  // Pre-launch map QA: toggle that injects synthetic moving vehicles so
  // we can preview how peer markers render before real drivers are
  // online. Gated to dev/demo builds — never shown to real users.
  const vehiclePreviewAvailable =
    __DEV__ || process.env.EXPO_PUBLIC_DEMO_MODE === 'true';
  const [vehiclePreview, setVehiclePreview] = useState(false);
  useEffect(() => {
    if (!vehiclePreviewAvailable) return;
    AsyncStorage.getItem('client_vehicle_preview').then((val) => {
      if (val === '1') setVehiclePreview(true);
    }).catch(() => {});
  }, [vehiclePreviewAvailable]);
  const toggleVehiclePreview = useCallback(() => {
    setVehiclePreview((prev) => {
      const next = !prev;
      AsyncStorage.setItem('client_vehicle_preview', next ? '1' : '0').catch(() => {});
      return next;
    });
  }, []);
  // Center the preview on the user's location (NOT on pickup — the real
  // useNearbyVehicles needs a pickup, but the preview should work the
  // instant the map opens).
  const vehiclePreviewCenter = useMemo(
    () => (userCenter ? { lat: userCenter[1], lng: userCenter[0] } : null),
    [userCenter],
  );
  const previewVehicles = useTestVehicles(vehiclePreviewCenter, vehiclePreview);
  const nearestDriverETA = useMemo(() => {
    if (!draft.pickup?.location || !nearbyVehicles || nearbyVehicles.length === 0) return null;
    const distances = nearbyVehicles.map((v) => ({
      distance: haversineDistance(draft.pickup!.location, { latitude: v.latitude, longitude: v.longitude }),
    }));
    distances.sort((a, b) => a.distance - b.distance);
    const nearest = distances[0];
    if (!nearest) return null;
    // Estimate: 20 km/h average city speed, 1.3x road factor
    const roadDistanceM = nearest.distance * 1.3;
    const etaMinutes = Math.max(1, Math.round((roadDistanceM / 1000) / 20 * 60));
    return etaMinutes;
  }, [draft.pickup?.location, nearbyVehicles]);

  // ETA per vehicle type (min ETA from nearby vehicles of that type)
  const etaByVehicleType = useMemo(() => {
    if (!nearbyVehicles || nearbyVehicles.length === 0 || !draft.pickup?.location) return {} as Record<string, number>;
    const result: Record<string, number> = {};
    for (const v of nearbyVehicles) {
      const dist = haversineDistance(draft.pickup!.location, { latitude: v.latitude, longitude: v.longitude });
      const etaMin = Math.max(1, Math.round((dist * 1.3 / 1000) / 20 * 60));
      // Narrow through a local so `result[...]` doesn't resolve to
      // `number | undefined` under noUncheckedIndexedAccess.
      const existing = result[v.vehicle_type];
      if (existing === undefined || etaMin < existing) {
        result[v.vehicle_type] = etaMin;
      }
    }
    return result;
  }, [draft.pickup?.location, nearbyVehicles]);

  // UBER-4.4: Load saved payment method on mount
  useEffect(() => {
    AsyncStorage.getItem('last_payment_method').then((saved) => {
      if (saved && (saved === 'cash' || saved === 'tricicoin' || saved === 'mixed') && !draft.paymentMethod) {
        setPaymentMethod(saved);
      }
    }).catch(() => {});
  }, []);

  // UBER-4.4: Persist payment method when it changes
  const handlePaymentMethodChange = useCallback((method: 'cash' | 'tricicoin' | 'mixed') => {
    setPaymentMethod(method);
    AsyncStorage.setItem('last_payment_method', method).catch(() => {});
  }, [setPaymentMethod]);

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
  // Bug 22/28: Clear promoResult so stale discount is not applied to new estimate
  const prevPaymentRef = useRef(draft.paymentMethod);
  useEffect(() => {
    if (draft.paymentMethod !== prevPaymentRef.current) {
      prevPaymentRef.current = draft.paymentMethod;
      const store = useRideStore.getState();
      if (store.promoResult) store.setPromoResult(null);
      const fe = store.fareEstimate;
      if (fe) requestEstimate();
    }
  }, [draft.paymentMethod, requestEstimate]);

  // PASS #3 PROMO-STALE: clear a validated promo when the service type changes.
  // The discount was validated against the previous service's fare; leaving it
  // would show a stale (possibly free-looking) price on the new fare. Mirrors
  // the payment-method effect above.
  const prevServiceRef = useRef(draft.serviceType);
  useEffect(() => {
    if (draft.serviceType !== prevServiceRef.current) {
      prevServiceRef.current = draft.serviceType;
      const store = useRideStore.getState();
      if (store.promoResult) store.setPromoResult(null);
    }
  }, [draft.serviceType]);

  // Load saved locations from customer profile
  useEffect(() => {
    if (!user?.id) return;
    customerService.ensureProfile(user.id).then((cp) => {
      setSavedLocations(cp.saved_locations ?? []);
    }).catch(() => {});
  }, [user?.id]);

  // Auto-populate pickup from pre-fetched location (if empty or has only coordinates)
  useEffect(() => {
    if (!prefetchedPickup) return;
    const currentPickup = useRideStore.getState().draft.pickup;
    if (!currentPickup || (currentPickup.address.match(/^-?\d+\.\d+/) && prefetchedPickup.address !== currentPickup.address)) {
      setPickup(prefetchedPickup.address, prefetchedPickup.location);
    }
  }, [prefetchedPickup, setPickup]);

  // Auto-open destination search when entering selecting flow without dropoff
  useEffect(() => {
    if (!draft.dropoff) {
      setSearchingField('dropoff');
    }
  }, []); // Only on mount

  // Auto-fetch estimates when both pickup and dropoff are set, or when waypoints change.
  // Track both lat AND lng so moving within same latitude band triggers a re-estimate.
  // Do NOT gate on !isFareEstimating: if route changes mid-flight, we'd skip and never retry
  // (isFareEstimating is not in deps, so returning to false doesn't re-run the effect).
  const waypointLocationKey = draft.waypoints.map((w) => w.location ? `${w.location.latitude},${w.location.longitude}` : 'null').join('|');
  useEffect(() => {
    if (draft.pickup?.location && draft.dropoff?.location) {
      requestEstimate();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.pickup?.location?.latitude, draft.pickup?.location?.longitude, draft.dropoff?.location?.latitude, draft.dropoff?.location?.longitude, waypointLocationKey]);

  // BUG-223: auto-refresh fare estimate every 60s while the user is still
  // selecting a service. Surge multiplier and time-of-day rules can change
  // while the user is staring at the cards, so a stale estimate could
  // mismatch the actual fare charged. SelectingView only mounts during
  // flowStep='selecting', so unmount on confirm/cancel naturally clears
  // the interval.
  useEffect(() => {
    if (!draft.pickup?.location || !draft.dropoff?.location) return;
    const intervalId = setInterval(() => {
      const { fareEstimatedAt } = useRideStore.getState();
      // Skip if a recent estimate (<55s ago) just landed — avoids hammering
      // the API on each render of this hook re-entry.
      if (fareEstimatedAt && Date.now() - fareEstimatedAt < 55_000) return;
      // eslint-disable-next-line no-console
      console.log('[FareRefresh] auto-refreshing estimate (60s TTL)');
      requestEstimate();
    }, 60_000);
    return () => clearInterval(intervalId);
  }, [draft.pickup?.location?.latitude, draft.pickup?.location?.longitude, draft.dropoff?.location?.latitude, draft.dropoff?.location?.longitude, requestEstimate]);

  const isDelivery = draft.serviceType === 'mensajeria';
  const deliveryValid = !isDelivery || (
    draft.delivery.packageDescription.trim() &&
    draft.delivery.recipientName.trim() &&
    draft.delivery.recipientPhone.trim() &&
    !!draft.delivery.deliveryVehicleType
  );
  const canEstimate = draft.pickup && draft.dropoff && deliveryValid;

  return (
    <View style={{ flex: 1 }}>
      {/* Fullscreen map with route */}
      <RideMapView
        fullscreen
        pickupLocation={draft.pickup?.location ?? null}
        dropoffLocation={draft.dropoff?.location ?? null}
        routeCoordinates={routeCoordinates ?? null}
        nearbyVehicles={vehiclePreview ? previewVehicles : (nearbyVehicles ?? [])}
        waypointLocations={draft.waypoints.filter((wp) => wp.location !== null).map((wp) => wp.location!)}
        // BUG-282 — open map at the user's actual location instead of the
        // demo-city fallback (São Paulo). userCenter resolves from cached
        // AsyncStorage instantly, then upgrades when GPS gives a fresh fix.
        initialUserCenter={userCenter}
      />

      {/* Pre-launch map QA toggle — dev/demo only, never in production.
          When ON, the map shows synthetic moving vehicles so the team
          can preview how vehicle markers render before real drivers are
          online. Mirrors the driver app's equivalent toggle. */}
      {vehiclePreviewAvailable && (
        <Pressable
          onPress={toggleVehiclePreview}
          accessibilityRole="switch"
          accessibilityState={{ checked: vehiclePreview }}
          accessibilityLabel="Vehículos de prueba"
          style={({ pressed }) => ({
            position: 'absolute',
            top: insets.top + 140,
            left: 12,
            width: 52,
            height: 52,
            borderRadius: 26,
            backgroundColor: vehiclePreview ? '#FF4D00' : 'rgba(8, 8, 12, 0.85)',
            borderWidth: 2,
            borderColor: '#FFFFFF',
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.35,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 3 },
            elevation: 16,
            zIndex: 60,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Ionicons name="car-sport" size={24} color="#FFFFFF" />
        </Pressable>
      )}

      {/* Crowdsourcing — "Sugerir lugar" floating button (PR 3 of POI
          parity). Only visible when not searching/selecting addresses —
          no clutter while user is actively booking. */}
      {!searchingField && submitPoiCoords && (
        <Pressable
          onPress={() => setSubmitPoiOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Sugerir lugar nuevo"
          style={{
            position: 'absolute',
            top: insets.top + 80,
            right: 12,
            width: 44, height: 44, borderRadius: 22,
            backgroundColor: 'rgba(255,255,255,0.95)',
            borderWidth: 1,
            borderColor: 'rgba(0,0,0,0.08)',
            alignItems: 'center', justifyContent: 'center',
            shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
            elevation: 4,
            zIndex: 30,
          }}
        >
          <Ionicons name="add" size={26} color="#FF4D00" />
        </Pressable>
      )}

      {/* SubmitPoiSheet — opens when user taps "+" floating button */}
      {submitPoiCoords && (
        <SubmitPoiSheet
          visible={submitPoiOpen}
          onClose={() => setSubmitPoiOpen(false)}
          lat={submitPoiCoords.latitude}
          lng={submitPoiCoords.longitude}
          supabase={getSupabaseClient()}
        />
      )}

      {/* Floating top bar: [X] + compact address summary */}
      {!searchingField && (
        <View style={{ position: 'absolute', top: insets.top + 8, left: 12, right: 12, zIndex: 10, flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          {/* Close button — 44px touch target. Sticky-serviceType fix:
              closing SelectingView discards the whole draft (start fresh) so a
              half-configured mensajería order can't leak into the next trip. */}
          <Pressable onPress={() => { resetDraft(); setFlowStep('idle'); }} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, marginTop: 2 }}>
            <Ionicons name="close" size={22} color={colors.neutral[700]} />
          </Pressable>

          {/* Two compact address rows — tap to open fullscreen search */}
          <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 14, elevation: 4, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, overflow: 'hidden' }}>
            <Pressable onPress={() => setSearchingField('pickup')} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, minHeight: 44 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: MAP_COLORS.pickup, marginRight: 10 }} />
              <Text variant="body" numberOfLines={1} style={{ flex: 1, color: draft.pickup?.address ? colors.neutral[900] : colors.neutral[400] }}>
                {draft.pickup?.address || t('ride.enter_pickup', { defaultValue: 'Punto de recogida' })}
              </Text>
              <Ionicons name="pencil-outline" size={14} color={colors.neutral[400]} />
            </Pressable>
            <View style={{ height: 1, backgroundColor: colors.neutral[100], marginHorizontal: 12 }} />
            <Pressable onPress={() => setSearchingField('dropoff')} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, minHeight: 44 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.brand.orange, marginRight: 10 }} />
              <Text variant="body" numberOfLines={1} style={{ flex: 1, color: draft.dropoff?.address ? colors.neutral[900] : colors.neutral[400] }}>
                {draft.dropoff?.address || t('ride.where_to', { defaultValue: '¿A dónde vas?' })}
              </Text>
              <Ionicons name="pencil-outline" size={14} color={colors.neutral[400]} />
            </Pressable>
          </View>

          {/* Swap button — 40px + hitSlop for 56px touch area */}
          {draft.pickup && draft.dropoff && (
            <Pressable onPress={() => { triggerHaptic('light'); swapPickupDropoff(); }} hitSlop={8} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', elevation: 3, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, marginTop: 14 }}>
              <Ionicons name="swap-vertical" size={18} color={colors.neutral[500]} />
            </Pressable>
          )}
        </View>
      )}

      {/* Fullscreen search panel — opens when user taps an address input */}
      {searchingField && (
        <ScrollView
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: tokens.bg.paper, zIndex: 20, paddingTop: insets.top + 8 }}
          contentContainerStyle={{ paddingHorizontal: 16, flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="none"
        >
          {/* Header: back arrow + field label */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <Pressable onPress={() => setSearchingField(null)} style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="arrow-back" size={24} color={tokens.ink.primary} />
            </Pressable>
            <Text variant="h4" style={{ flex: 1, marginLeft: 8 }}>
              {searchingField === 'pickup'
                ? t('ride.enter_pickup', { defaultValue: 'Punto de recogida' })
                : searchingField === 'waypoint'
                  ? t('ride.add_stop_title', { defaultValue: 'Agregar parada' })
                  : t('ride.where_to', { defaultValue: '¿A dónde vas?' })}
            </Text>
          </View>

          {/* AddressSearchInput — always in search mode, auto-expanded with suggestions */}
          <AddressSearchInput
            autoExpand
            placeholder={searchingField === 'pickup'
              ? t('ride.enter_pickup', { defaultValue: 'Punto de recogida' })
              : searchingField === 'waypoint'
                ? t('ride.add_stop_placeholder', { defaultValue: 'Buscar parada intermedia' })
                : t('ride.where_to', { defaultValue: '¿A dónde vas?' })}
            onSelect={(address, location) => {
              if (searchingField === 'pickup') {
                setPickup(address, location);
              } else if (searchingField === 'waypoint') {
                // Update the last added waypoint (addWaypoint was called before opening search)
                const wpIdx = draft.waypoints.length - 1;
                if (wpIdx >= 0) updateWaypoint(wpIdx, address, location);
              } else {
                setDropoff(address, location);
              }
              setSearchingField(null);
            }}
            savedLocations={savedLocations}
            recentAddresses={recentAddresses}
            predictions={searchingField === 'dropoff' ? predictions : undefined}
            showUseMyLocation={searchingField === 'pickup'}
            onPickOnMap={() => {
              setSearchingField(null);
              setMapPickerMode(searchingField);
            }}
          />
        </ScrollView>
      )}

      {/* Route distance/duration badge (floating above bottom panel)
          BUG-208 (8a): "min por ruta" was confusing — users read it as a
          per-route surcharge. BUG-221: also was using routeDurationS (OSRM
          default ~40 km/h ≈ 15 min for 9.9 km) which never matched any
          card below (triciclo 64, moto 25, auto 30, confort 28). Now uses
          the SELECTED service's estimated_duration_s, falling back to
          routeDurationS only if no estimate is available yet. */}
      {!searchingField && routeDistanceM && (selectedEstimate?.estimated_duration_s || routeDurationS) && (
        <View style={{ position: 'absolute', bottom: '52%', alignSelf: 'center', zIndex: 9, backgroundColor: colors.brand.orange, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, elevation: 3, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } }}>
          <Text variant="caption" style={{ color: '#fff', fontWeight: '600' }}>
            {(routeDistanceM / 1000).toFixed(1)} km · ~{Math.ceil((selectedEstimate?.estimated_duration_s ?? routeDurationS ?? 0) / 60)} min
          </Text>
        </View>
      )}

      {/* Bottom panel — services, payment, request (hidden during search) */}
      {!searchingField && (draft.pickup && draft.dropoff) && (
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: tokens.bg.elev1, borderTopLeftRadius: 20, borderTopRightRadius: 20, elevation: 10, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 0, height: -3 }, paddingHorizontal: 16, paddingTop: 12, paddingBottom: insets.bottom + 8, maxHeight: '50%' }}>
          <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: mode === 'dark' ? tokens.ink.subtle : colors.neutral[300], marginBottom: 8 }} />
          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Paso 1+2: Service cards — vertical stack with ETA + trip duration */}
            {(['triciclo_basico', 'moto_standard', 'auto_standard', 'auto_confort', 'mensajeria'] as const).map((slug) => {
              const meta = SERVICE_META[slug];
              // Mensajería muestra el precio del VEHÍCULO elegido (no su config
              // plano): resuelve al slug del vehículo. Alinea con la web.
              const est =
                slug === 'mensajeria' && draft.delivery.deliveryVehicleType
                  ? allFareEstimates?.[deliveryVehicleToSlug(draft.delivery.deliveryVehicleType)]
                  : allFareEstimates?.[slug];
              const isSelected = draft.serviceType === slug;
              const eta = etaByVehicleType[slug];
              return (
                <Pressable key={slug} onPress={() => { triggerHaptic('light'); setServiceType(slug); }} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, borderRadius: 12, marginBottom: 8, borderWidth: isSelected ? 2 : 1, borderColor: isSelected ? colors.brand.orange : (mode === 'dark' ? tokens.line : colors.neutral[200]), backgroundColor: isSelected ? (mode === 'dark' ? tokens.accent.orangeGlow : '#FFF5F0') : (mode === 'dark' ? tokens.bg.elev2 : '#fff') }}>
                  <Image source={VEHICLE_ICONS[slug]} style={{ width: 36, height: 36, marginRight: 12 }} resizeMode="contain" />
                  <View style={{ flex: 1 }}>
                    <Text variant="body" style={{ fontWeight: '600' }}>{meta?.label ?? slug}</Text>
                    <Text variant="caption" color="tertiary">
                      {meta?.desc}{eta ? <Text style={{ color: MAP_COLORS.pickup }}> · {eta} min</Text> : null}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    {est ? (
                      <>
                        <Text variant="body" style={{ fontWeight: '700', color: isSelected ? colors.brand.orange : tokens.ink.primary }}>{formatFare(est.estimated_fare_cup, est.estimated_fare_trc)}</Text>
                        {est.estimated_duration_s ? (
                          <Text variant="caption" color="tertiary">~{Math.ceil(est.estimated_duration_s / 60)} min de viaje</Text>
                        ) : null}
                        {slug === 'mensajeria' ? (
                          <Text variant="caption" color="tertiary">{t('delivery.price_by_vehicle', { defaultValue: 'Según vehículo' })}</Text>
                        ) : null}
                      </>
                    ) : isFareEstimating ? (
                      <ActivityIndicator size="small" color={colors.neutral[300]} />
                    ) : null}
                  </View>
                </Pressable>
              );
            })}

            {/* Delivery form — shown when mensajeria selected */}
            {draft.serviceType === 'mensajeria' && (
              <View style={{ backgroundColor: mode === 'dark' ? tokens.bg.elev2 : colors.neutral[50], borderRadius: 12, padding: 12, marginBottom: 8 }}>
                <Text variant="caption" color="secondary" style={{ fontWeight: '600', marginBottom: 8 }}>
                  {t('delivery.details', { defaultValue: 'Datos del envío' })}
                </Text>
                {/* Delivery vehicle selector — UX: the chips used to map
                     to ServiceTypeSlug values ('moto_standard', etc) but
                     the store's `deliveryVehicleType` field is the
                     short VehicleType ('moto'/'triciclo'/'auto') — the
                     two enums never matched so `=== vt` was always
                     false, leaving every chip visually unselected and
                     silently saving garbage. Switched to VehicleType so
                     selection actually sticks and `deliveryVehicleToSlug`
                     can do its job at submit time. */}
                <Text variant="caption" color="tertiary" style={{ marginBottom: 4 }}>{t('delivery.vehicle', { defaultValue: 'Vehículo de envío' })}</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4 }}>
                  {(['moto', 'triciclo', 'auto', 'confort'] as const).map((vt) => {
                    const vLabel = ({ moto: 'Moto', triciclo: 'Triciclo', auto: 'Auto', confort: 'Confort' } as const)[vt];
                    const isSel = draft.delivery.deliveryVehicleType === vt;
                    // Dispatch enforces accepts_cargo, weight and category
                    // fail-closed (00326 + 00512). Picking a vehicle that
                    // cannot take this package no longer just under-matches —
                    // it produces ZERO offers and a ride that searches until
                    // the watchdog kills it, with nothing on screen explaining
                    // why. So the mismatch is surfaced here, before booking.
                    const opt = deliveryVehicleOptions.find((o) => o.type === vt);
                    const blocked = opt ? !opt.compatibility.compatible : false;
                    const reason = blocked
                      ? INCOMPATIBILITY_REASON_LABELS[opt!.compatibility.reason ?? '']?.[deliveryReasonLang] ?? null
                      : null;
                    return (
                      <Pressable
                        key={vt}
                        onPress={() => { if (!blocked) setDeliveryField('deliveryVehicleType', vt); }}
                        disabled={blocked}
                        accessibilityRole="button"
                        accessibilityState={{ selected: isSel, disabled: blocked }}
                        accessibilityLabel={reason ? `${vLabel} — ${reason}` : vLabel}
                        style={{ flex: 1, paddingVertical: 8, borderRadius: 8, opacity: blocked ? 0.45 : 1, borderWidth: isSel ? 2 : 1, borderColor: isSel ? colors.brand.orange : (mode === 'dark' ? tokens.line : colors.neutral[200]), backgroundColor: isSel ? (mode === 'dark' ? tokens.accent.orangeGlow : '#FFF5F0') : (mode === 'dark' ? tokens.bg.elev1 : '#fff'), alignItems: 'center' }}
                      >
                        <Text variant="caption" style={{ fontWeight: isSel ? '700' : '400', color: isSel ? colors.brand.orange : (mode === 'dark' ? tokens.ink.secondary : colors.neutral[600]), fontSize: 11 }}>{vLabel}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                {/* The reason in words, not just a dimmed chip: greying out
                    alone tells the rider nothing about what to change. */}
                {deliveryBlockedNote && (
                  <Text variant="caption" color="tertiary" style={{ marginBottom: 8, fontSize: 11 }}>
                    {deliveryBlockedNote}
                  </Text>
                )}
                {/* Recipient */}
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text variant="caption" color="tertiary" style={{ marginBottom: 2 }}>{t('delivery.recipient_name', { defaultValue: 'Destinatario' })}</Text>
                    <TextInput value={draft.delivery.recipientName} onChangeText={(v) => setDeliveryField('recipientName', v)} placeholder="Nombre" placeholderTextColor={mode === 'dark' ? tokens.ink.subtle : colors.neutral[400]} style={{ backgroundColor: mode === 'dark' ? tokens.bg.elev1 : '#fff', borderRadius: 8, borderWidth: 1, borderColor: mode === 'dark' ? tokens.line : colors.neutral[200], paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: tokens.ink.primary }} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text variant="caption" color="tertiary" style={{ marginBottom: 2 }}>{t('delivery.recipient_phone', { defaultValue: 'Teléfono' })}</Text>
                    <TextInput value={draft.delivery.recipientPhone} onChangeText={(v) => setDeliveryField('recipientPhone', v)} placeholder="+53 5..." placeholderTextColor={mode === 'dark' ? tokens.ink.subtle : colors.neutral[400]} keyboardType="phone-pad" style={{ backgroundColor: mode === 'dark' ? tokens.bg.elev1 : '#fff', borderRadius: 8, borderWidth: 1, borderColor: mode === 'dark' ? tokens.line : colors.neutral[200], paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: tokens.ink.primary }} />
                  </View>
                </View>
                {/* Package category chips */}
                <Text variant="caption" color="tertiary" style={{ marginBottom: 4 }}>{t('delivery.package_category', { defaultValue: 'Categoría' })}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {/* UX/bugfix: chips used English keys ('documents',
                       'food', …) but PackageCategory is Spanish
                       ('documentos', 'comida', 'paquete_pequeno',
                       'paquete_grande', 'fragil'). The `=== cat` check
                       never matched and the `as PackageCategory` cast
                       saved invalid enum values that the backend then
                       rejected. Switched to the real values so
                       selection persists and survives the server
                       insert. */}
                    {(['documentos', 'comida', 'paquete_pequeno', 'paquete_grande', 'fragil'] as const).map((cat) => {
                      const catLabels: Record<typeof cat, string> = {
                        documentos: 'Documentos',
                        comida: 'Alimentos',
                        paquete_pequeno: 'Paquete pequeño',
                        paquete_grande: 'Paquete grande',
                        fragil: 'Frágil',
                      };
                      const isCatSel = draft.delivery.packageCategory === cat;
                      return (
                        <Pressable key={cat} onPress={() => setDeliveryField('packageCategory', cat)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: isCatSel ? colors.brand.orange : (mode === 'dark' ? tokens.line : colors.neutral[200]), backgroundColor: isCatSel ? (mode === 'dark' ? tokens.accent.orangeGlow : '#FFF5F0') : (mode === 'dark' ? tokens.bg.elev1 : '#fff') }}>
                          <Text variant="caption" style={{ color: isCatSel ? colors.brand.orange : (mode === 'dark' ? tokens.ink.secondary : colors.neutral[600]), fontWeight: isCatSel ? '600' : '400' }}>{catLabels[cat]}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </ScrollView>
                {/* Description + Weight */}
                <TextInput value={draft.delivery.packageDescription} onChangeText={(v) => setDeliveryField('packageDescription', v)} placeholder={t('delivery.description_placeholder', { defaultValue: 'Descripción del paquete' })} placeholderTextColor={mode === 'dark' ? tokens.ink.subtle : colors.neutral[400]} style={{ backgroundColor: mode === 'dark' ? tokens.bg.elev1 : '#fff', borderRadius: 8, borderWidth: 1, borderColor: mode === 'dark' ? tokens.line : colors.neutral[200], paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: tokens.ink.primary, marginBottom: 8 }} />
                {/* Bugfix: estimatedWeightKg is typed as string in the
                     store (matches the raw input). Keep the value as a
                     string — server-side parses to number via fare
                     estimate. Stripping non-digits keeps the input
                     numeric-looking without breaking the store type. */}
                <TextInput value={draft.delivery.estimatedWeightKg} onChangeText={(v) => setDeliveryField('estimatedWeightKg', v.replace(/[^0-9.]/g, ''))} placeholder={t('delivery.weight', { defaultValue: 'Peso estimado (kg)' })} placeholderTextColor={mode === 'dark' ? tokens.ink.subtle : colors.neutral[400]} keyboardType="numeric" style={{ backgroundColor: mode === 'dark' ? tokens.bg.elev1 : '#fff', borderRadius: 8, borderWidth: 1, borderColor: mode === 'dark' ? tokens.line : colors.neutral[200], paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: tokens.ink.primary, marginBottom: 8 }} />
                {/* Special instructions */}
                <TextInput value={draft.delivery.specialInstructions} onChangeText={(v) => setDeliveryField('specialInstructions', v)} placeholder={t('delivery.instructions', { defaultValue: 'Instrucciones especiales (opcional)' })} placeholderTextColor={mode === 'dark' ? tokens.ink.subtle : colors.neutral[400]} style={{ backgroundColor: mode === 'dark' ? tokens.bg.elev1 : '#fff', borderRadius: 8, borderWidth: 1, borderColor: mode === 'dark' ? tokens.line : colors.neutral[200], paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: tokens.ink.primary, marginBottom: 8 }} />
                {/* Client accompanies toggle */}
                <Pressable onPress={() => setDeliveryField('clientAccompanies', !draft.delivery.clientAccompanies)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
                  <Ionicons name={draft.delivery.clientAccompanies ? 'checkbox' : 'square-outline'} size={20} color={draft.delivery.clientAccompanies ? colors.brand.orange : colors.neutral[400]} />
                  <Text variant="caption" color="secondary">{t('delivery.accompany', { defaultValue: 'Acompaño el envío' })}</Text>
                </Pressable>
              </View>
            )}

            {/* Passenger count selector. Hidden when the nested "Compartir
                viaje" seats stepper is showing (tricycle + sharing on) so the
                rider is asked the passenger count only once. */}
            {draft.serviceType !== 'mensajeria' &&
              !(draft.serviceType === 'triciclo_basico' && draft.shareRide && selectedEstimate && selectedEstimate.estimated_fare_cup > 0) && (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, marginBottom: 4 }}>
                <Text variant="caption" color="secondary" style={{ fontWeight: '600' }}>{t('ride.passengers', { defaultValue: 'Pasajeros' })}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <Pressable onPress={() => { triggerHaptic('light'); setPassengerCount(Math.max(1, (draft.passengerCount || 1) - 1)); }} hitSlop={8} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.neutral[200], alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontWeight: '700', color: colors.neutral[700] }}>−</Text>
                  </Pressable>
                  <Text variant="body" style={{ fontWeight: '700', minWidth: 20, textAlign: 'center' }}>{draft.passengerCount || 1}</Text>
                  <Pressable onPress={() => { triggerHaptic('light'); setPassengerCount(Math.min(6, (draft.passengerCount || 1) + 1)); }} hitSlop={8} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.neutral[200], alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontWeight: '700', color: colors.neutral[700] }}>+</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Paradas — Cuban Modern, StopsList + add-stop CTA on-brand */}
            <View style={{ marginBottom: 12 }}>
              <StopsList
                mode={mode}
                stops={draft.waypoints
                  .filter(wp => wp.address)
                  .map((wp, i) => ({
                    sort_order: i + 1,
                    address: wp.address,
                  }))}
                onRemove={(idx) => {
                  // StopsList shows only waypoints that have an address;
                  // map back to the real draft index using the address.
                  const wp = draft.waypoints.filter(x => x.address)[idx];
                  if (!wp) return;
                  const realIdx = draft.waypoints.findIndex(x => x === wp);
                  if (realIdx >= 0) removeWaypoint(realIdx);
                }}
              />
              {draft.waypoints.filter(wp => wp.address).length < 3 && (
                <Pressable
                  onPress={() => { addWaypoint(); setSearchingField('waypoint' as any); }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    paddingVertical: 12,
                    paddingHorizontal: 16,
                    marginTop: draft.waypoints.filter(wp => wp.address).length > 0 ? 10 : 0,
                    borderRadius: 14,
                    borderWidth: 1,
                    borderStyle: 'dashed',
                    borderColor: tokens.accent.orange,
                    backgroundColor: pressed ? tokens.accent.orangeGlow : 'transparent',
                  })}
                  accessibilityRole="button"
                >
                  {/* Plus built from two rotated lines — sticks to the
                      design language (no Ionicons). */}
                  <View style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
                    <View style={{ position: 'absolute', width: 14, height: 1.8, backgroundColor: tokens.accent.orange, borderRadius: 2 }} />
                    <View style={{ position: 'absolute', width: 1.8, height: 14, backgroundColor: tokens.accent.orange, borderRadius: 2 }} />
                  </View>
                  <Text style={{ fontFamily: 'JetBrainsMono_500Medium', fontSize: 11, letterSpacing: 2, color: tokens.accent.orange }}>
                    {`AGREGAR PARADA · ${draft.waypoints.filter(wp => wp.address).length}/3`}
                  </Text>
                </Pressable>
              )}
            </View>

            {/* Paso 4: Fare estimate summary box */}
            {selectedEstimate && (
              <View style={{ borderWidth: 2, borderColor: colors.brand.orange, borderRadius: 12, padding: 12, marginBottom: 8, backgroundColor: 'rgba(255,77,0,0.03)' }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text variant="caption" color="secondary">{t('ride.estimated_fare', { defaultValue: 'Tarifa estimada' })}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                    {totalDiscountCup > 0 && (
                      <Text style={{ fontSize: 13, color: colors.neutral[400], textDecorationLine: 'line-through' }}>{formatFare(grossCup, selectedEstimate.estimated_fare_trc)}</Text>
                    )}
                    <Text style={{ fontSize: 18, fontWeight: '800', color: colors.brand.orange }}>{formatFare(netCup, netTrc)}</Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
                  <Text variant="caption" color="tertiary">{(selectedEstimate.estimated_distance_m / 1000).toFixed(1)} km</Text>
                  <Text variant="caption" color="tertiary">{Math.ceil(selectedEstimate.estimated_duration_s / 60)} min</Text>
                  {selectedEstimate.exchange_rate_usd_cup ? (
                    <Text variant="caption" color="tertiary">~${(netCup / selectedEstimate.exchange_rate_usd_cup).toFixed(2)} USD</Text>
                  ) : null}
                </View>
                {selectedEstimate.estimated_distance_m > 0 && (
                  <Text variant="caption" color="tertiary" style={{ marginTop: 4 }}>
                    {Math.round(selectedEstimate.estimated_fare_cup / (selectedEstimate.estimated_distance_m / 1000))} CUP por km
                  </Text>
                )}
                {shareDiscountCup > 0 && (
                  <Text variant="caption" style={{ color: MAP_COLORS.pickup, marginTop: 4, fontWeight: '600' }}>
                    {t('ride.share_ride_toggle', { defaultValue: 'Compartir viaje' })} · −{formatCUP(shareDiscountCup)} (−{shareFreeSeats * SHARE_PCT}%)
                  </Text>
                )}
                {(selectedEstimate as any).surge_multiplier > 1 && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                    <Ionicons name="rainy" size={14} color="#ef4444" />
                    <Text variant="caption" style={{ color: '#ef4444', fontWeight: '600' }}>
                      {t('home.weather_surge_label', { defaultValue: 'Mal tiempo' })} ×{((selectedEstimate as any).surge_multiplier as number).toFixed(1)}
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* Payment method selector */}
            <Text variant="caption" color="secondary" style={{ marginBottom: 8, fontWeight: '600' }}>{t('ride.payment_method', { defaultValue: 'Método de pago' })}</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
              {(['cash', 'tricicoin', 'mixed'] as const).map((method) => (
                <Pressable key={method} onPress={() => handlePaymentMethodChange(method)} style={{ flex: 1, paddingVertical: 14, borderRadius: 10, borderWidth: draft.paymentMethod === method ? 2 : 1, borderColor: draft.paymentMethod === method ? colors.brand.orange : (mode === 'dark' ? tokens.line : colors.neutral[200]), backgroundColor: draft.paymentMethod === method ? (mode === 'dark' ? tokens.accent.orangeGlow : '#FFF5F0') : (mode === 'dark' ? tokens.bg.elev2 : '#fff'), alignItems: 'center', justifyContent: 'center' }}>
                  <Text variant="caption" style={{ fontWeight: draft.paymentMethod === method ? '700' : '400', color: draft.paymentMethod === method ? colors.brand.orange : (mode === 'dark' ? tokens.ink.secondary : colors.neutral[500]) }}>{method === 'cash' ? 'Efectivo' : method === 'tricicoin' ? 'TriciCoin' : 'Mixto'}</Text>
                </Pressable>
              ))}
            </View>

            {/* Mixed payment slider */}
            {draft.paymentMethod === 'mixed' && selectedEstimate && (
              <View style={{ backgroundColor: colors.neutral[50], borderRadius: 12, padding: 12, marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Text variant="caption" color="secondary">Billetera: {Math.round(draft.walletRatio * 100)}%</Text>
                  <Text variant="caption" color="secondary">Efectivo: {Math.round((1 - draft.walletRatio) * 100)}%</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Pressable onPress={() => { triggerHaptic('light'); setWalletRatio(Math.max(0, draft.walletRatio - 0.1)); }} hitSlop={8} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.neutral[200], alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontWeight: '700', color: colors.neutral[700] }}>−</Text>
                  </Pressable>
                  <View style={{ flex: 1, height: 6, backgroundColor: colors.neutral[200], borderRadius: 3, overflow: 'hidden' }}>
                    <View style={{ width: `${draft.walletRatio * 100}%`, height: '100%', backgroundColor: colors.brand.orange, borderRadius: 3 }} />
                  </View>
                  <Pressable onPress={() => { triggerHaptic('light'); setWalletRatio(Math.min(1, draft.walletRatio + 0.1)); }} hitSlop={8} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.neutral[200], alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontWeight: '700', color: colors.neutral[700] }}>+</Text>
                  </Pressable>
                </View>
                <Text variant="caption" color="tertiary" style={{ textAlign: 'center', marginTop: 8 }}>
                  {formatCUP(selectedEstimate.estimated_fare_cup * draft.walletRatio)} billetera + {formatCUP(selectedEstimate.estimated_fare_cup * (1 - draft.walletRatio))} efectivo
                </Text>
              </View>
            )}

            {/* Promo code */}
            <Pressable onPress={() => setPromoExpanded(!promoExpanded)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 }}>
              <Text variant="caption" color="secondary" style={{ fontWeight: '600' }}>{t('ride.promo_code', { defaultValue: 'Código promocional' })}</Text>
              <Ionicons name={promoExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.neutral[400]} />
            </Pressable>
            {promoExpanded && (
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                <View style={{ flex: 1, backgroundColor: colors.neutral[100], borderRadius: 10, paddingHorizontal: 12, justifyContent: 'center', minHeight: 44 }}>
                  <TextInput
                    value={promoCode}
                    onChangeText={setPromoCode}
                    placeholder={t('ride.enter_code', { defaultValue: 'Ingresa un código' })}
                    placeholderTextColor={colors.neutral[400]}
                    style={{ fontSize: 14, color: colors.neutral[700], paddingVertical: 12 }}
                    autoCapitalize="characters"
                  />
                </View>
                <Button title={t('common.apply', { defaultValue: 'Aplicar' })} size="sm" onPress={() => validatePromo()} loading={validatingPromo} disabled={!promoCode.trim()} />
              </View>
            )}
            {promoResult?.valid && (
              <View style={{ backgroundColor: '#f0fdf4', borderRadius: 8, padding: 8, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="checkmark-circle" size={16} color={MAP_COLORS.pickup} />
                <Text variant="caption" style={{ color: MAP_COLORS.pickup }}>{'¡'}Descuento de {formatCUP(promoResult.discountAmount)} aplicado!</Text>
              </View>
            )}

            {/* Compartir viaje (solo triciclo) — descuento por asiento libre */}
            {draft.serviceType === 'triciclo_basico' && selectedEstimate && selectedEstimate.estimated_fare_cup > 0 && (
              <View style={{ marginBottom: 8 }}>
                <Pressable
                  onPress={() => { triggerHaptic('light'); handleShareRideToggle(!draft.shareRide); }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, borderWidth: draft.shareRide ? 1 : 0, borderColor: colors.brand.orange, backgroundColor: draft.shareRide ? (mode === 'dark' ? tokens.accent.orangeGlow : '#FFF5F0') : (mode === 'dark' ? tokens.bg.elev2 : colors.neutral[50]) }}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: draft.shareRide }}
                  accessibilityLabel={t('ride.share_ride_toggle', { defaultValue: 'Compartir viaje' })}
                >
                  <Ionicons name="people-outline" size={22} color={draft.shareRide ? colors.brand.orange : colors.neutral[400]} />
                  <View style={{ flex: 1 }}>
                    <Text variant="caption" style={{ fontWeight: '600', color: draft.shareRide ? colors.brand.orange : (mode === 'dark' ? tokens.ink.secondary : colors.neutral[700]) }}>
                      {t('ride.share_ride_toggle', { defaultValue: 'Compartir viaje' })}
                    </Text>
                    <Text variant="caption" color="tertiary">
                      {draft.shareRide && shareFreeSeats > 0
                        ? t('ride.share_ride_active', { defaultValue: '{{seats}} asientos libres · −{{pct}}%', seats: shareFreeSeats, pct: shareFreeSeats * SHARE_PCT })
                        : t('ride.share_ride_desc', { defaultValue: 'El chofer puede recoger gente en los asientos libres y pagas menos' })}
                    </Text>
                  </View>
                  <Switch
                    value={draft.shareRide}
                    onValueChange={(val) => handleShareRideToggle(val)}
                    trackColor={{ false: '#D1D5DB', true: colors.brand.orange }}
                    thumbColor="white"
                  />
                </Pressable>
                {draft.shareRide && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, paddingHorizontal: 4 }}>
                    <Text variant="caption" color="secondary">{t('ride.share_ride_seats_q', { defaultValue: '¿Cuántos van contigo?' })}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <Pressable onPress={() => { triggerHaptic('light'); setPassengerCount(Math.max(1, (draft.passengerCount || 1) - 1)); }} hitSlop={8} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.neutral[200], alignItems: 'center', justifyContent: 'center' }}>
                        <Text style={{ fontWeight: '700', color: colors.neutral[700] }}>−</Text>
                      </Pressable>
                      <Text variant="body" style={{ minWidth: 20, textAlign: 'center', fontWeight: '700' }}>{draft.passengerCount || 1}</Text>
                      <Pressable onPress={() => { triggerHaptic('light'); setPassengerCount(Math.min(3, (draft.passengerCount || 1) + 1)); }} hitSlop={8} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.neutral[200], alignItems: 'center', justifyContent: 'center' }}>
                        <Text style={{ fontWeight: '700', color: colors.neutral[700] }}>+</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
              </View>
            )}

          </ScrollView>
          <Button title={selectedEstimate ? `${t('ride.request', { defaultValue: 'Solicitar' })} ${t(`service_type.${draft.serviceType}` as const)} · ${formatFare(netCup, netTrc)}` : isFareEstimating ? t('home.calculating', { defaultValue: 'Calculando tarifa...' }) : t('ride.select_locations', { defaultValue: 'Selecciona recogida y destino' })} size="lg" fullWidth onPress={debouncedConfirmRide} loading={isFareEstimating} disabled={!selectedEstimate} style={{ marginTop: 8 }} />
        </View>
      )}
    </View>
  );
}

// SelectingView old form code removed — now uses fullscreen map layout above

// ── Reviewing View (BottomSheet) ───────────────────────────

function ReviewingView() {
  const { t } = useTranslation('rider');
  const { isTablet } = useResponsive();
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const mode: 'light' | 'dark' = resolvedScheme;
  const tokens = mode === 'dark' ? cubanDark : cubanLight;
  const { draft, fareEstimate, allFareEstimates, setFlowStep, setServiceType, isLoading, isFareEstimating, error, promoCode, promoResult, setPromoCode, splits, setInsurance, setRidePreferences, setShareRide, activeRide } = useRideStore();

  /** Format fare based on payment method */
  const formatFare = useCallback((cupAmount: number, trcAmount?: number): string => {
    if (draft.paymentMethod === 'tricicoin') {
      return formatTRC(trcAmount ?? cupAmount);
    }
    return formatCUP(cupAmount);
  }, [draft.paymentMethod]);
  const { requestEstimate, confirmRide, validatePromo, validatingPromo } = useRideActions();
  const user = useAuthStore((s) => s.user);
  const [promoExpanded, setPromoExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const insuranceEnabled = useFeatureFlag('trip_insurance_enabled');
  const preferencesEnabled = useFeatureFlag('ride_preferences_enabled');
  const { accounts: corporateAccounts } = useCorporateAccounts();
  const debouncedConfirmRide = useDebouncePress(() => { triggerHaptic('medium'); confirmRide(); });
  const [splitSheetVisible, setSplitSheetVisible] = useState(false);

  // U1.2: Pre-select most-used service type from ride history
  const [recentRides, setRecentRides] = useState<{ service_type?: string }[]>([]);
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    rideService.getRideHistory(user.id, 0, 10).then((rides) => {
      if (!cancelled) setRecentRides(rides);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [user?.id]);

  const preferredService = useMemo(() => {
    if (!recentRides || recentRides.length === 0) return 'auto_standard';
    const counts: Record<string, number> = {};
    recentRides.slice(0, 10).forEach((r) => {
      if (r.service_type) counts[r.service_type] = (counts[r.service_type] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'auto_standard';
  }, [recentRides]);

  // UBER-1.1: Calculate distance and recommend service
  const distanceM = useMemo(() => {
    if (!draft.pickup?.location || !draft.dropoff?.location) return 0;
    return haversineDistance(draft.pickup.location, draft.dropoff.location);
  }, [draft.pickup?.location, draft.dropoff?.location]);

  const recommendedSlug = useMemo(
    () => getRecommendedService(distanceM, draft.passengerCount || 1),
    [distanceM, draft.passengerCount],
  );

  const [servicePreSelected, setServicePreSelected] = useState(false);
  useEffect(() => {
    if (!draft.serviceType && !servicePreSelected) {
      setServiceType(recommendedSlug);
      setServicePreSelected(true);
    }
  }, [recommendedSlug, draft.serviceType, servicePreSelected, setServiceType]);

  // UBER-1.1: Derive other (non-selected) services for secondary chips
  const allServiceSlugs: ServiceTypeSlug[] = ['moto_standard', 'triciclo_basico', 'auto_standard', 'auto_confort', 'mensajeria'];
  const selectedSlug = draft.serviceType || recommendedSlug;
  const otherServices = allServiceSlugs.filter((s) => s !== selectedSlug);

  const handleServiceSwap = useCallback((slug: ServiceTypeSlug) => {
    setServiceType(slug);
    triggerSelection();
    requestEstimate();
  }, [setServiceType, requestEstimate]);

  // UBER-1.2: Smart confirm label
  const selectedServiceLabel = t(`service_type.${selectedSlug}` as const);
  const confirmLabel = fareEstimate
    ? t('home.request_with_details', {
        service: selectedServiceLabel,
        fare: formatCUP(fareEstimate.estimated_fare_cup),
        eta: Math.ceil((fareEstimate.estimated_duration_s || 0) / 60),
      })
    : t('home.calculating', { defaultValue: 'Calculando...' });
  const reviewWaypointPoints = useMemo(
    // Type-guarded so `w.location` narrows through the map() step —
    // the old filter returned the same Waypoint shape and TS couldn't
    // carry the truthy narrow across the function boundary, producing
    // a possibly-null deref. A type predicate fixes this cleanly.
    () => draft.waypoints
      .filter((w): w is typeof w & { location: NonNullable<typeof w.location> } =>
        !!w.address && !!w.location)
      .map((w) => ({ latitude: w.location.latitude, longitude: w.location.longitude })),
    [draft.waypoints],
  );
  const { coordinates: routeCoordinates } = useRoutePolyline(draft.pickup?.location, draft.dropoff?.location, reviewWaypointPoints);
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

  const promoDiscount = promoResult?.valid ? (promoResult.discountAmount ?? 0) : 0;
  // "Compartir viaje" preview discount (the server trigger 00347 recomputes
  // it authoritatively at booking — this is display-only). Tricycle capacity
  // is 4; free seats = 4 − seats the rider occupies (passengerCount). Default
  // 7% per free seat.
  const shareFreeSeats =
    draft.serviceType === 'triciclo_basico' && draft.shareRide
      ? Math.max(0, 4 - (draft.passengerCount || 1))
      : 0;
  const shareDiscount =
    shareFreeSeats > 0
      ? Math.floor((fareEstimate?.estimated_fare_cup ?? 0) * shareFreeSeats * 7 / 100)
      : 0;
  const discount = promoDiscount + shareDiscount;

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
      <View className="h-3" />

      {/* UBER-1.1: Recommended service PRIMARY card */}
      <View
        className="border-2 border-primary-500 rounded-xl p-4 mb-3 relative"
        style={{ shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3, backgroundColor: tokens.bg.elev1 }}
      >
        {/* "Recomendado" badge */}
        {selectedSlug === recommendedSlug && (
          <View className="absolute -top-3 right-3 bg-primary-500 rounded-full px-3 py-0.5 z-10">
            <Text variant="caption" color="inverse" style={{ fontSize: 11, fontWeight: '700' }}>
              {t('home.recommended', { defaultValue: 'Recomendado' })}
            </Text>
          </View>
        )}
        <View className="flex-row items-center">
          <Image
            source={vehicleSelectionImages[selectedSlug] ?? vehicleSelectionImages.auto_standard}
            style={{ width: 56, height: 56 }}
            resizeMode="contain"
          />
          <View className="flex-1 ml-3">
            <Text variant="h3" className="font-bold">
              {t(`service_type.${selectedSlug}` as const)}
            </Text>
            <View className="flex-row items-center mt-1">
              {fareEstimate.estimated_duration_s != null && fareEstimate.estimated_duration_s > 0 && (
                <Text variant="bodySmall" color="secondary">
                  ~{Math.ceil(fareEstimate.estimated_duration_s / 60)} {t('home.min', { defaultValue: 'min' })}
                </Text>
              )}
              {fareEstimate.estimated_duration_s != null && fareEstimate.estimated_duration_s > 0 && (
                <Text variant="bodySmall" color="tertiary" className="mx-1">·</Text>
              )}
              <Text variant="bodySmall" color="secondary">
                {t('home.passengers_short', {
                  count: SERVICE_META[selectedSlug]?.maxPax ?? 4,
                  defaultValue: `${SERVICE_META[selectedSlug]?.maxPax ?? 4} pax`,
                })}
              </Text>
            </View>
          </View>
          <View className="items-end">
            <Text variant="h2" color="accent" className="font-bold">
              {formatFare(fareEstimate.estimated_fare_cup, fareEstimate.estimated_fare_trc)}
            </Text>
            {fareEstimate?.exchange_rate_usd_cup > 0 && (
              <Text variant="caption" color="tertiary">
                ~${(fareEstimate?.estimated_fare_cup / fareEstimate?.exchange_rate_usd_cup).toFixed(2)} USD
              </Text>
            )}
          </View>
        </View>
        {/* Distance · Per-km rate · Exchange rate */}
        <View className="flex-row flex-wrap items-center mt-2 pt-2 border-t border-neutral-100 dark:border-neutral-800 gap-x-3 gap-y-1">
          {fareEstimate?.estimated_distance_m > 0 && (
            <Text variant="caption" color="secondary">
              {(fareEstimate?.estimated_distance_m / 1000).toFixed(1)} km
            </Text>
          )}
          {fareEstimate?.per_km_rate_cup > 0 && (
            <Text variant="caption" color="tertiary">
              {formatFare(fareEstimate?.per_km_rate_cup)}/km
            </Text>
          )}
          {fareEstimate?.exchange_rate_usd_cup > 0 && (
            <Text variant="caption" color="tertiary">
              1 USD = {formatCUP(fareEstimate?.exchange_rate_usd_cup)} CUP
            </Text>
          )}
        </View>
      </View>

      {/* UBER-1.1: Secondary service chips */}
      <View className="mb-4">
        <Text variant="caption" color="tertiary" className="mb-2">
          {t('home.other_services', { defaultValue: 'Otras opciones' })}
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-2">
            {otherServices.map((slug) => {
              // Mensajería muestra el precio del vehículo elegido (alinea con la web).
              const est =
                slug === 'mensajeria' && draft.delivery.deliveryVehicleType
                  ? allFareEstimates?.[deliveryVehicleToSlug(draft.delivery.deliveryVehicleType)]
                  : allFareEstimates?.[slug];
              return (
                <Pressable
                  key={slug}
                  className="bg-neutral-100 dark:bg-neutral-800 rounded-full px-4 py-2 flex-row items-center"
                  onPress={() => handleServiceSwap(slug)}
                  accessibilityRole="radio"
                  accessibilityLabel={t(`service_type.${slug}` as const)}
                  accessibilityState={{ selected: false }}
                >
                  <Image
                    source={vehicleSelectionImages[slug]}
                    style={{ width: 24, height: 24, marginRight: 6 }}
                    resizeMode="contain"
                  />
                  <Text variant="caption" className="text-neutral-600 dark:text-neutral-300 font-medium">
                    {SERVICE_META[slug]?.label ?? slug}
                  </Text>
                  {est && (
                    <Text variant="caption" color="accent" className="ml-2 font-semibold">
                      {formatFare(est.estimated_fare_cup, est.estimated_fare_trc)}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>

      {/* ETA display */}
      {fareEstimate.estimated_duration_s != null && fareEstimate.estimated_duration_s > 0 && (
        <View className="flex-row items-center mb-4 px-1">
          <Ionicons name="time-outline" size={16} color={colors.neutral[500]} />
          <Text variant="bodySmall" color="secondary" className="ml-2">
            {t('home.eta_with_clock', {
              minutes: Math.ceil(fareEstimate.estimated_duration_s / 60),
              time: formatArrivalTime(Math.ceil(fareEstimate.estimated_duration_s / 60)),
              defaultValue: '~{{minutes}} min · llega ~{{time}}',
            })}
          </Text>
        </View>
      )}

      {/* Weather surge alert (visible when bad weather raises the fare) */}
      {fareEstimate.surge_multiplier != null && fareEstimate.surge_multiplier > 1 && (
        <View
          className="flex-row items-center rounded-xl px-4 py-3 mb-4"
          style={{ backgroundColor: '#FEF3C7' }}
          accessibilityRole="alert"
        >
          <Ionicons name="rainy" size={20} color="#D97706" />
          <View className="flex-1 ml-3">
            <Text variant="bodySmall" className="font-bold" style={{ color: '#92400E' }}>
              {t('home.surge_active_label', { defaultValue: 'Recargo por mal tiempo' })} (x{fareEstimate.surge_multiplier})
            </Text>
            <Text variant="caption" style={{ color: '#92400E' }}>
              {t('home.surge_explanation', { defaultValue: 'Los precios suben temporalmente por el mal tiempo (lluvia, tormenta o frío).' })}
            </Text>
          </View>
        </View>
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

      {/* Bug 29: Disable confirm button while promo is validating */}
      <Button
        title={confirmLabel}
        size="lg"
        fullWidth
        onPress={debouncedConfirmRide}
        loading={isLoading || isFareEstimating || validatingPromo}
        className="mb-3"
      />
      <Button
        title={t('home.back', { defaultValue: 'Volver' })}
        variant="ghost"
        size="lg"
        fullWidth
        onPress={() => setFlowStep('selecting')}
      />

      {/* View details toggle */}
      <Pressable
        className="py-3 items-center"
        onPress={() => setDetailsExpanded(!detailsExpanded)}
      >
        <Text variant="bodySmall" color="accent" className="underline">
          {detailsExpanded ? t('home.hide_details') : t('home.view_details')}
        </Text>
      </Pressable>

      {/* Collapsible details section */}
      {detailsExpanded && (
        <>
          {/* UX-3: Route summary (moved from main view) */}
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

          {/* UX-3: Nearby vehicles count (moved from main view) */}
          <View className="mt-1 mb-3">
            <Text variant="caption" color="secondary" className="text-center">
              {nearbyVehicles.length > 0
                ? t('ride.nearby_vehicles', { count: nearbyVehicles.length })
                : t('ride.no_nearby_vehicles', { defaultValue: 'Sin conductores cercanos' })}
            </Text>
          </View>

          {/* Fare breakdown */}
          {/* BUG-067: Discount applies only to base fare (before insurance premium).
              The order is: baseFare → distance → duration → surge → discount → subtotal → insurance → total.
              Insurance premium is calculated on the full fare and added after the discount is applied. */}
          <View className="mb-4">
            <FareBreakdownCard
              title={t('ride.fare_breakdown', { defaultValue: 'Desglose de tarifa' })}
              baseFareCup={fareEstimate.base_fare_cup}
              distanceM={fareEstimate.estimated_distance_m}
              perKmRateCup={fareEstimate.per_km_rate_cup}
              durationS={fareEstimate.estimated_duration_s}
              perMinRateCup={fareEstimate.per_minute_rate_cup}
              surgeMultiplier={fareEstimate.surge_multiplier ?? 1}
              surgeLabel={fareEstimate.surge_multiplier && fareEstimate.surge_multiplier > 1 ? t('ride.surge_active', { defaultValue: 'Mal tiempo' }) : undefined}
              surgeType={fareEstimate.surge_type}
              weatherSurgeLabel={t('ride.surge_active', { defaultValue: 'Mal tiempo' })}
              totalCup={fareEstimate.estimated_fare_cup}
              totalTrc={fareEstimate.estimated_fare_trc}
              totalLabel={t('ride.estimated_fare')}
              discountCup={discount} /* Bugfix: prop is discountCup (TRC = CUP 1:1, the component computes TRC internally). `discountTrc` was never accepted by FareBreakdownCardProps so the value was silently dropped — the card rendered without the discount. */
              discountLabel={discount > 0 ? (shareDiscount > 0 && promoDiscount === 0 ? t('ride.share_discount', { defaultValue: 'Compartir viaje' }) : t('ride.discount', { defaultValue: 'Descuento' })) : undefined}
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

          {/* U1.4: Fare range context */}
          {/* Bugfix: `paymentMethod` is a local state of WebHomeScreen; in
               ReviewingView (native) the equivalent lives on the ride
               draft. Reference the store value so this branch runs
               without a ReferenceError on native. */}
          {fareEstimate.estimated_fare_cup > 0 && (
            <Text variant="caption" color="tertiary" className="text-center mt-2 mb-4" style={{ color: colors.neutral[500] }}>
              {draft.paymentMethod === 'tricicoin'
                ? `Este viaje suele costar ${formatTRC(Math.max(0, Math.round((fareEstimate.estimated_fare_trc ?? fareEstimate.estimated_fare_cup) * 0.85) - discount))} – ${formatTRC(Math.max(0, Math.round((fareEstimate.estimated_fare_trc ?? fareEstimate.estimated_fare_cup) * 1.15) - discount))}`
                : t('home.usual_fare_range', {
                    low: Math.max(0, Math.round(fareEstimate.estimated_fare_cup * 0.85) - discount).toLocaleString('es-CU'),
                    high: Math.max(0, Math.round(fareEstimate.estimated_fare_cup * 1.15) - discount).toLocaleString('es-CU'),
                    defaultValue: 'Este viaje suele costar {{low}} - {{high}} CUP',
                  })
              }
            </Text>
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

          {/* Compartir viaje toggle (solo triciclo) */}
          {draft.serviceType === 'triciclo_basico' && fareEstimate.estimated_fare_cup > 0 && (
            <Pressable
              className={`flex-row items-center rounded-xl px-4 py-3 mb-4 ${
                draft.shareRide ? 'bg-primary-50 border border-primary-500' : 'bg-neutral-100'
              }`}
              onPress={() => setShareRide(!draft.shareRide)}
              accessibilityRole="switch"
              accessibilityState={{ checked: draft.shareRide }}
              accessibilityLabel={t('ride.share_ride_toggle', { defaultValue: 'Compartir viaje' })}
            >
              <Ionicons name="people-outline" size={20} color={draft.shareRide ? colors.brand.orange : colors.neutral[500]} />
              <View className="flex-1 ml-3">
                <Text variant="body" color={draft.shareRide ? 'primary' : undefined}>
                  {t('ride.share_ride_toggle', { defaultValue: 'Compartir viaje' })}
                </Text>
                <Text variant="caption" color="secondary">
                  {draft.shareRide && shareFreeSeats > 0
                    ? t('ride.share_ride_active', { defaultValue: '{{seats}} asientos libres · −{{pct}}%', seats: shareFreeSeats, pct: shareFreeSeats * 7 })
                    : t('ride.share_ride_desc', { defaultValue: 'El chofer puede recoger gente en los asientos libres y pagas menos' })}
                </Text>
              </View>
              <Switch
                value={draft.shareRide}
                onValueChange={(val) => setShareRide(val)}
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
                  {/* discountAmount comes back in CUP from validate_promo_code —
                      formatTRC labelled it "TRC" (TriciCoin), a different unit. */}
                  {promoResult.valid
                    ? t('ride.discount_applied', { defaultValue: `Descuento de ${formatCUP(promoResult.discountAmount)} aplicado`, amount: formatCUP(promoResult.discountAmount) })
                    : promoResult.error ?? t('ride.promo_invalid')}
                </Text>
              )}
            </Card>
          )}

          {/* Split fare — only for tricicoin AND when ride exists (has rideId) */}
          {/* BUG-066: Guard against stale activeRide — only show split fare when ride is in a valid pre-completion state */}
          {draft.paymentMethod === 'tricicoin' && fareEstimate && activeRide?.id && ['searching', 'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress'].includes(activeRide.status) && (
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
        </>
      )}
    </View>
  );
}

// ── Radar pulse animation for searching state ──────────────
function RadarPulseAnimation() {
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;
  const rings = [ring1, ring2, ring3];

  useEffect(() => {
    rings.forEach((ring, i) => {
      const loop = () => {
        ring.setValue(0);
        Animated.timing(ring, {
          toValue: 1,
          duration: 2000,
          delay: i * 600,
          useNativeDriver: true,
        }).start(({ finished }) => { if (finished) loop(); });
      };
      loop();
    });
    return () => rings.forEach((r) => r.stopAnimation());
  }, []);

  return (
    <View style={{ width: 100, height: 100, alignItems: 'center', justifyContent: 'center' }}>
      {rings.map((ring, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            width: 56,
            height: 56,
            borderRadius: 28,
            borderWidth: 2,
            borderColor: 'rgba(255,77,0,0.3)',
            opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
            transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.8, 2.2] }) }],
          }}
        />
      ))}
      {/* Center dot with vehicle icon */}
      <View style={{
        width: 48, height: 48, borderRadius: 24,
        backgroundColor: colors.brand.orange,
        alignItems: 'center', justifyContent: 'center',
        shadowColor: colors.brand.orange, shadowOpacity: 0.35,
        shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8,
      }}>
        <Ionicons name="car" size={22} color="#fff" />
      </View>
    </View>
  );
}

// ── Searching View ─────────────────────────────────────────

function SearchingView() {
  const { t } = useTranslation('rider');
  const { isTablet } = useResponsive();
  const { isLoading, error, activeRide } = useRideStore();
  const { cancelRide, requestEstimate } = useRideActions();
  const { coordinates: routeCoordinates } = useRoutePolyline(
    activeRide?.pickup_location ?? null,
    activeRide?.dropoff_location ?? null,
  );

  // ── Interactive searching: real-time driver presence ──
  const {
    searchingDrivers,
    acceptedDriver,
    isAcceptAnimating,
  } = useSearchingDrivers(activeRide?.id ?? null);

  // ── Ride-offer stats (pending count + countdown + dispatch round) ──
  // Migration 00127 via useRideOfferStats. Polls every 3s.
  const offerStats = useRideOfferStats({
    rideId: activeRide?.id ?? null,
    enabled: activeRide?.status === 'searching',
  });

  // Live countdown based on earliest_expires_at. Ticks every 500ms.
  const [offerSecondsLeft, setOfferSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!offerStats?.earliest_expires_at) {
      setOfferSecondsLeft(null);
      return;
    }
    const expiresMs = new Date(offerStats.earliest_expires_at).getTime();
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((expiresMs - Date.now()) / 1000));
      setOfferSecondsLeft(remaining);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [offerStats?.earliest_expires_at]);

  // Flash "Ampliando búsqueda…" when dispatch_round advances
  const prevRoundRef = useRef<number | null>(null);
  const [showExpandingMsg, setShowExpandingMsg] = useState(false);
  useEffect(() => {
    const round = offerStats?.dispatch_round ?? null;
    if (round !== null && prevRoundRef.current !== null && round > prevRoundRef.current) {
      setShowExpandingMsg(true);
      // UX: a text flash alone is easy to miss if the rider glances away
      // at the 30s mark. Pair it with a soft haptic tap so they feel the
      // search advance even without looking at the screen.
      triggerHaptic('light');
      const id = setTimeout(() => setShowExpandingMsg(false), 2500);
      return () => clearTimeout(id);
    }
    prevRoundRef.current = round;
  }, [offerStats?.dispatch_round]);

  // UBER-2.1: 5-phase progressive search messages with fade transitions
  const [searchPhase, setSearchPhase] = useState(0);
  const searchFadeAnim = useRef(new Animated.Value(1)).current;

  const fadeAndSetPhase = useCallback((phase: number) => {
    Animated.timing(searchFadeAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(({ finished }) => {
      if (!finished) return; // Component unmounted or animation interrupted
      setSearchPhase(phase);
      Animated.timing(searchFadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    });
  }, [searchFadeAnim]);

  useEffect(() => {
    const timers = [
      setTimeout(() => { fadeAndSetPhase(1); }, 15000),
      setTimeout(() => { fadeAndSetPhase(2); }, 30000),
      setTimeout(() => { fadeAndSetPhase(3); }, 60000),
      setTimeout(() => { fadeAndSetPhase(4); }, 90000),
    ];
    return () => timers.forEach(clearTimeout);
  }, [fadeAndSetPhase]);

  // UBER-2.1: Progress bar animation (0% to 100% over 120s search timeout)
  const progressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: 1,
      duration: 120000,
      useNativeDriver: false,
    }).start();
    return () => { progressAnim.stopAnimation(); };
  }, [progressAnim]);

  // I3.1: Search timeout state
  const [searchTimedOut, setSearchTimedOut] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => setSearchTimedOut(true), 120_000);
    return () => clearTimeout(timeout);
  }, []);

  // UX: drivers show an elapsed time counter so the rider can frame their
  // own wait — is this normal? am I stuck? — without counting in their head.
  // The counter also lets us gate reassurance and hint messages on time.
  const searchStartedAtRef = useRef(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - searchStartedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  const elapsedLabel = (() => {
    const total = elapsedSeconds;
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
  })();

  // I3.3: Retry handler
  const handleRetrySearch = useCallback(() => {
    setSearchTimedOut(false);
    setSearchPhase(0);
    progressAnim.setValue(0);
    Animated.timing(progressAnim, { toValue: 1, duration: 120000, useNativeDriver: false }).start();
    requestEstimate();
  }, [progressAnim, requestEstimate]);

  const SEARCH_MESSAGES = [
    t('home.searching_best'),
    t('home.checking_nearby'),
    t('home.drivers_evaluating', { count: 2 }),
    t('home.expanding_moment'),
    t('home.few_drivers'),
  ];

  // Prefer live server-side state over the legacy time-based phases.
  const fallbackMessage = SEARCH_MESSAGES[searchPhase] ?? SEARCH_MESSAGES[0];
  const searchMessage = (() => {
    if (showExpandingMsg) {
      return t('home.expanding_moment', { defaultValue: 'Ampliando búsqueda…' });
    }
    const pending = offerStats?.pending_count ?? 0;
    if (pending > 0) {
      if (offerSecondsLeft !== null && offerSecondsLeft > 0) {
        return t('home.drivers_evaluating_countdown', {
          count: pending,
          seconds: offerSecondsLeft,
          defaultValue: `${pending} conductor${pending === 1 ? '' : 'es'} evaluando · ${offerSecondsLeft}s`,
        });
      }
      return t('home.drivers_evaluating', {
        count: pending,
        defaultValue: `${pending} conductor${pending === 1 ? '' : 'es'} evaluando tu viaje`,
      });
    }
    // No pending offers but still searching — either pre-dispatch, mid-retry, or last round.
    // UX: the literal "Sin conductores disponibles" felt terminal — riders
    // read it as "the app failed" and canceled. The search is actually
    // still running (dispatch_round 3 just means the zone widened); say so.
    if ((offerStats?.dispatch_round ?? 0) >= 3) {
      return t('home.no_drivers_final', {
        defaultValue: 'Buscando en un área más amplia…',
      });
    }
    return fallbackMessage;
  })();

  const searchSteps = useMemo(() => [
    { key: 'searching', label: t('ride.searching_driver') },
    { key: 'accepted', label: t('ride.status_accepted') },
    { key: 'driver_en_route', label: t('ride.status_driver_en_route') },
    { key: 'in_progress', label: t('ride.status_in_progress') },
  ], [t]);

  return (
    <View className="pt-4 flex-1 items-center">
      {/* Map showing pickup + dropoff with route + searching drivers */}
      {activeRide && (
        <>
          <RideMapView
            pickupLocation={activeRide.pickup_location}
            dropoffLocation={activeRide.dropoff_location}
            routeCoordinates={routeCoordinates}
            searchingDrivers={searchingDrivers}
            acceptedDriverId={acceptedDriver?.driverId ?? null}
            isAcceptAnimating={isAcceptAnimating}
            acceptedDriverLocation={acceptedDriver?.location ?? null}
            // BUG-218: pass driver vehicle type so the map shows the
            // correct vehicle icon (almendrón / moto / triciclo / confort)
            // instead of the generic blue dot fallback.
            vehicleType={acceptedDriver?.vehicleType ?? undefined}
            height={isTablet ? 300 : 220}
          />
          <View className="h-3" />
        </>
      )}

      {/* Driver accepted — celebration card overlay */}
      {acceptedDriver && isAcceptAnimating && (
        <AcceptedDriverCard
          driver={acceptedDriver}
          onAnimationComplete={() => {
            // The normal ride status update flow will transition to 'active'
          }}
        />
      )}

      {/* BUG-293: radar dot now lives inside the DriverInfoMiniCard header.
           The standalone floating car icon felt disconnected from the rest
           of the searching state. Keeping it ONLY for the timed-out case so
           the rider has a visible signal something is still happening. */}

      {/* Interactive driver presence mini-card — now carries pickup/
           dropoff/fare so the rider has useful context while waiting. */}
      {!acceptedDriver && activeRide && (() => {
        // BUG-293: replicate the showTrc/showCup fare display pattern from
        // RideActiveView so the badge inside the card respects payment
        // method (cash → CUP, tricicoin → TRC).
        const showTrc = activeRide.payment_method === 'tricicoin';
        const fareTrc = activeRide.estimated_fare_trc;
        const fareCup = activeRide.estimated_fare_cup;
        const fareDisplay =
          showTrc && fareTrc != null
            ? formatTRC(fareTrc)
            : formatCUP(fareCup ?? 0);
        const serviceSlug = activeRide.service_type;
        const serviceTypeLabel = serviceSlug
          ? t(`service_type.${serviceSlug}` as const, { defaultValue: String(serviceSlug) })
          : null;
        const durationS = activeRide.estimated_duration_s ?? null;
        const etaLabel = durationS && durationS > 0
          ? t('ride.trip_duration_min', {
              defaultValue: `~${Math.ceil(durationS / 60)} min`,
              minutes: Math.ceil(durationS / 60),
            })
          : null;
        return (
          <DriverInfoMiniCard
            drivers={searchingDrivers}
            isSearching={!searchTimedOut}
            pickupAddress={activeRide.pickup_address ?? null}
            dropoffAddress={activeRide.dropoff_address ?? null}
            fareDisplay={fareDisplay}
            etaLabel={etaLabel}
            serviceTypeLabel={serviceTypeLabel}
          />
        );
      })()}

      {/* Fallback radar — visible only while the card itself isn't shown
           (e.g. when activeRide is null in an edge state). */}
      {!acceptedDriver && !searchTimedOut && !activeRide && (
        <View style={{ alignItems: 'center', justifyContent: 'center', height: 100, marginBottom: 8 }}>
          <RadarPulseAnimation />
        </View>
      )}

      <StatusStepper
        steps={searchSteps}
        currentStep="searching"
        className="w-full mb-6"
      />

      {/* I3.2: Timeout UI vs active search UI */}
      {searchTimedOut ? (
        <View className="items-center mb-6 px-6">
          <Ionicons name="alert-circle-outline" size={48} color="#9CA3AF" />
          <Text variant="h4" className="mt-3 mb-2 text-center">
            {t('ride.no_driver_found_title')}
          </Text>
          <Text variant="bodySmall" color="secondary" className="mb-6 text-center">
            {t('ride.no_driver_found_subtitle')}
          </Text>
          <Button
            title={t('ride.retry_search')}
            size="lg"
            fullWidth
            onPress={handleRetrySearch}
          />
        </View>
      ) : !acceptedDriver ? (
        <>
          <Animated.View style={{ opacity: searchFadeAnim }}>
            <Text variant="bodySmall" color="secondary" className="mb-2 text-center">
              {searchMessage}
            </Text>
          </Animated.View>
          {/* UX: frame the expected wait so riders don't read silent
               searching as a stuck app. Only show before there's a
               pending offer (which has its own live countdown) and only
               during the opening window so it doesn't shout at users who
               are already deep in the wait. */}
          {elapsedSeconds < 15 && (offerStats?.pending_count ?? 0) === 0 && (
            <Text variant="caption" color="tertiary" className="mb-4 text-center">
              {t('home.typical_wait_hint', { defaultValue: 'Normalmente menos de 2 minutos' })}
            </Text>
          )}
          {/* UX: at the mid-wait mark, reassure the rider that the search
               is still actively running. 45-90s is exactly the zone where
               anxiety spikes but timeout hasn't fired. */}
          {elapsedSeconds >= 45 && elapsedSeconds < 90 && (offerStats?.pending_count ?? 0) === 0 && (
            <Text variant="caption" color="tertiary" className="mb-4 text-center">
              {t('home.still_searching_hint', { defaultValue: 'Seguimos buscando — puedes cancelar si necesitas.' })}
            </Text>
          )}

          {/* Thin progress bar — when a pending offer exists, show the
               30s offer window draining; otherwise keep the legacy
               120s stale-ride progress as a fallback. */}
          <View className="w-full px-8 mb-6">
            <View style={{ height: 3, backgroundColor: '#E5E7EB', borderRadius: 2, overflow: 'hidden' }}>
              {offerSecondsLeft !== null && offerSecondsLeft > 0 ? (
                <View
                  style={{
                    height: '100%',
                    backgroundColor: colors.brand.orange,
                    borderRadius: 2,
                    width: `${Math.max(0, Math.min(100, (offerSecondsLeft / 30) * 100))}%`,
                  }}
                />
              ) : (
                <Animated.View
                  style={{
                    height: '100%',
                    backgroundColor: colors.brand.orange,
                    borderRadius: 2,
                    width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
                  }}
                />
              )}
            </View>
          </View>

          {error && (
            <Text variant="bodySmall" color="error" className="mb-4 text-center">
              {error}
            </Text>
          )}
        </>
      ) : null}

      <Button
        /* UX: append elapsed wait to the cancel label so the rider has
             their own timer in the primary escape action. "Cancelar
             búsqueda · 1:23" feels like control; a bare "Cancelar" after
             a silent 2-minute wait felt like surrender. */
        title={`${t('ride.cancel_ride')} · ${elapsedLabel}`}
        variant="outline"
        size="lg"
        fullWidth
        onPress={() => {
          Alert.alert(
            t('ride.cancel_ride_title', { defaultValue: '¿Cancelar la búsqueda?' }),
            t('ride.cancel_ride_msg', { defaultValue: 'Perderás el progreso de la búsqueda actual. Si un conductor ya aceptó, podría aplicar una tarifa de cancelación.' }),
            [
              { text: t('common.back', { defaultValue: 'Volver' }), style: 'cancel' },
              {
                text: t('ride.cancel_ride', { defaultValue: 'Cancelar viaje' }),
                style: 'destructive',
                onPress: () => cancelRide(t('ride.canceled_by_passenger', { defaultValue: 'Cancelado por el pasajero' })),
              },
            ],
          );
        }}
        loading={isLoading}
      />
    </View>
  );
}

export default function HomeScreen() {
  if (Platform.OS === 'web') return <WebHomeScreen />;
  return <NativeHomeScreen />;
}
