import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { View, Pressable, ActivityIndicator, Platform, Switch, Image, Animated, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import Toast from 'react-native-toast-message';
import { formatTRC, formatCUP, triggerSelection, triggerHaptic, suggestPickupPoint, logger, haversineDistance, formatArrivalTime, serviceTypeToVehicleType } from '@tricigo/utils';
import * as Location from 'expo-location';
import { useTranslation } from '@tricigo/i18n';
import { walletService, customerService, useFeatureFlag, notificationService, getSupabaseClient } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { useNotificationStore } from '@/stores/notification.store';
import { useRideInit, useRideActions } from '@/hooks/useRide';
import { useRoutePolyline } from '@/hooks/useRoutePolyline';
import { WebMapView } from '@/components/WebMapView';
import type { WebMapViewRef } from '@/components/WebMapView';
import { WebAddressInput } from '@/components/WebAddressInput';
import { useNearbyVehicles } from '@/hooks/useNearbyVehicles';
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
import { colors } from '@tricigo/theme';
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
import { OnboardingOverlay } from '@/components/OnboardingOverlay';
import { useRiderLocationSharing } from '@/hooks/useRiderLocationSharing';
import { useSearchingDrivers } from '@/hooks/useSearchingDrivers';
import { DriverInfoMiniCard } from '@/components/DriverInfoMiniCard';
import { AcceptedDriverCard } from '@/components/AcceptedDriverCard';
import { WebActiveRideView } from '@/components/WebActiveRideView';
// Surge is calculated backend-side but not shown to users
// import { useSurgeZones } from '@/hooks/useSurgeZones';

// Mapbox GL for native fullscreen map (Uber-style home)
let MapboxGL: any = null;
try { MapboxGL = require('@rnmapbox/maps').default; } catch {}

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
  { name: 'Auto', desc: 'Cómodo', slug: 'auto_standard', img: require('../../assets/vehicles/selection/auto.png') },
  { name: 'Confort', desc: 'Premium', slug: 'auto_confort', img: require('../../assets/vehicles/selection/confort.png') },
  { name: 'Envío', desc: 'Delivery', slug: 'mensajeria', img: require('../../assets/vehicles/selection/mensajeria.png') },
];

const DELIVERY_VEHICLES: { slug: ServiceTypeSlug; label: string; img: any }[] = [
  { slug: 'moto_standard', label: 'Moto', img: require('../../assets/vehicles/selection/moto.png') },
  { slug: 'triciclo_basico', label: 'Triciclo', img: require('../../assets/vehicles/selection/triciclo.png') },
  { slug: 'auto_standard', label: 'Auto', img: require('../../assets/vehicles/selection/auto.png') },
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
      <div style={{ flex: 1, position: 'relative', background: '#f0f0f0' }}>
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
        backgroundColor: '#fff', borderLeft: '1px solid #e5e5e5',
        overflowY: 'auto', padding: '32px 28px',
        gap: 20, ...font,
      }}>
        {/* Header */}
        <div style={{ animation: 'ws-fadeIn 0.3s ease both' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '0.04em', marginBottom: 4 }}>
            {serviceType === 'mensajeria' ? 'Seguimiento de envío' : 'Seguimiento de viaje'}
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#1a1a1a', letterSpacing: '-0.02em' }}>
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
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#1a1a1a', textAlign: 'center' as const, marginBottom: 6 }}>
                No encontramos conductor
              </div>
              <div style={{ fontSize: 13, color: '#6b7280', textAlign: 'center' as const, marginBottom: 16 }}>
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
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{acceptedDriver.rating.toFixed(1)}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Searching drivers count + chips */}
              {!acceptedDriver && searchingDrivers.length > 0 && (
                <div style={{
                  width: '100%', background: '#fafafa',
                  border: '1px solid #f0f0f0', borderRadius: 12,
                  padding: '12px 14px', marginBottom: 12,
                  animation: 'ws-fadeIn 0.3s ease both',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: colors.brand.orange,
                      animation: 'ws-pulse 2s ease-in-out infinite',
                    }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#1a1a1a' }}>
                      {searchingDrivers.length} {searchingDrivers.length === 1 ? 'conductor revisando' : 'conductores revisando'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                    {searchingDrivers
                      .filter((d, i, arr) => arr.findIndex(x => x.driverId === d.driverId) === i)
                      .map((d) => (
                      <div key={d.driverId} style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        background: '#fff', borderRadius: 20,
                        padding: '5px 10px', border: '1px solid #e5e5e5',
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
                        <span style={{ fontSize: 12, fontWeight: 500, color: '#1a1a1a' }}>
                          {d.name.split(' ')[0]}
                        </span>
                        <span style={{ fontSize: 11, color: '#9ca3af' }}>{d.rating.toFixed(1)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ fontSize: 15, fontWeight: 700, color: '#1a1a1a', textAlign: 'center' as const, marginBottom: 4 }}>
                {acceptedDriver ? '' : 'Buscando conductor'}
              </div>
              {!acceptedDriver && (
              <div key={searchPhase} style={{
                fontSize: 13, color: '#6b7280', textAlign: 'center' as const,
                animation: 'ws-fadeIn 0.3s ease both',
              }}>
                {searchMessage}
              </div>
              )}

              {/* Progress bar */}
              <div style={{ width: '100%', marginTop: 16, padding: '0 12px' }}>
                <div style={{ height: 3, backgroundColor: '#e5e7eb', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', backgroundColor: colors.brand.orange,
                    borderRadius: 2, animation: 'ws-progress 120s linear forwards',
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11, color: '#9ca3af' }}>
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
            background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 12,
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
                      : { background: '#f0f0f0', color: '#9ca3af', border: '2px solid #e5e5e5' }),
                  }}>
                    {idx + 1}
                  </div>
                  {idx < 3 && (
                    <div style={{
                      width: 2, flex: 1, minHeight: 12, marginTop: 4,
                      background: step.active ? colors.brand.orange : '#e5e5e5',
                      ...(step.active ? {} : {
                        background: 'repeating-linear-gradient(to bottom, #e5e5e5 0px, #e5e5e5 3px, transparent 3px, transparent 6px)',
                      }),
                    }} />
                  )}
                </div>
                <span style={{
                  fontSize: 13, paddingTop: 3, lineHeight: '1.3',
                  ...(step.active
                    ? { fontWeight: 700, color: '#1a1a1a' }
                    : { fontWeight: 500, color: '#9ca3af' }),
                }}>
                  {step.label}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Route Card */}
        <div style={{
          background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 12,
          padding: 16, animation: 'ws-fadeIn 0.4s ease both 0.15s',
        }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 4, gap: 2 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
              <div style={{ width: 2, flex: 1, minHeight: 20, background: '#e5e5e5', borderRadius: 1 }} />
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '0.04em', marginBottom: 2 }}>Desde</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1a1a1a', lineHeight: '1.4' }}>{pickupAddress || 'Origen'}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '0.04em', marginBottom: 2 }}>Hasta</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1a1a1a', lineHeight: '1.4' }}>{dropoffAddress || 'Destino'}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Fare Card */}
        {selectedEstimate && (
          <div style={{
            background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 12,
            padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            animation: 'ws-fadeIn 0.4s ease both 0.2s',
          }}>
            <div>
              <div style={{ fontSize: 13, color: '#6b7280', fontWeight: 500 }}>Tarifa estimada</div>
              {selectedEstimate.estimated_distance_m && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
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
            background: 'transparent', color: '#6b7280',
            fontWeight: 600, fontSize: 14, cursor: 'pointer',
            border: '1.5px solid #e5e5e5', ...font,
            transition: 'all 0.2s ease',
            animation: 'ws-fadeIn 0.4s ease both 0.25s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#ef4444'; e.currentTarget.style.color = '#ef4444'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e5e5e5'; e.currentTarget.style.color = '#6b7280'; }}
          >
            Cancelar búsqueda
          </button>
        )}

        {/* Live indicator */}
        {!searchTimedOut && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 8, fontSize: 11, color: '#9ca3af', fontWeight: 500,
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
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'tricicoin'>('cash');

  /** Format fare price based on current payment method */
  const formatFare = useCallback((cupAmount: number, trcAmount?: number): string => {
    if (paymentMethod === 'tricicoin') {
      return formatTRC(trcAmount ?? cupAmount);
    }
    return `₧${formatCurrency(cupAmount)}`;
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
        const { fetchRoute } = await import('@tricigo/utils');
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
        const r = results[i];
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
        const msgs: Record<string, string> = { invalid: 'Código no válido', expired: 'Código expirado', max_uses: 'Código agotado', already_used: 'Ya usaste este código' };
        setPromoResult({ valid: false, discount: 0, error: msgs[result.error || 'invalid'] || 'Código no válido' });
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
      if (walletBalance < requiredAmount) {
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
    <View style={{ flex: 1, backgroundColor: '#f5f5f5' }}>
      <div style={{ display: 'flex', flexDirection: 'row', height: 'calc(100vh - 60px)', fontFamily: 'Montserrat, system-ui, sans-serif' }}>
        {/* ═══ LEFT SIDEBAR — Booking controls ═══ */}
        <div style={{
          width: 420, minWidth: 380, maxWidth: 460,
          display: 'flex', flexDirection: 'column',
          backgroundColor: '#fff', borderRight: '1px solid #e5e5e5',
          overflowY: 'auto',
        }}>
          <div style={{ padding: '24px 20px', flex: 1 }}>
            {/* Header */}
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 22, fontWeight: 800, color: '#1a1a1a', margin: 0 }}>
                Solicita tu viaje
              </h2>
              <p style={{ fontSize: 13, color: '#9ca3af', margin: '4px 0 0' }}>
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
                <Pressable onPress={handleSwap} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#f3f4f6', alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="swap-vertical" size={18} color="#6b7280" />
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
                  <button onClick={handleReset} type="button" style={{ padding: '6px 12px', borderRadius: 20, border: '1px solid #e5e5e5', backgroundColor: '#fff', fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
                    Limpiar
                  </button>
                )}
              </div>
            )}

            {/* Route info */}
            {routeInfo && (
              <div style={{ display: 'flex', gap: 16, fontSize: 13, color: '#6b7280', marginBottom: 16, padding: '10px 14px', backgroundColor: '#f9fafb', borderRadius: 10 }}>
                <span>📏 {(routeInfo.distance_m / 1000).toFixed(1)} km</span>
                <span>⏱ {Math.round(routeInfo.duration_s / 60)} min</span>
              </div>
            )}

            {/* ═══ Service cards ═══ */}
            <div style={{ marginBottom: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: '#6b7280', marginBottom: 8 }}>
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
                        border: isSelected ? '2px solid ' + colors.brand.orange : '1px solid #e5e5e5',
                        background: isSelected ? '#FFF5F0' : '#fff',
                        cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <Image source={svc.img} style={{ width: 40, height: 40 }} resizeMode="contain" />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14, color: '#1a1a1a' }}>{svc.name}</div>
                          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                            {isMensajeria ? 'Según vehículo' : svc.desc}
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {isLoadingEst ? (
                          <div style={{ width: 60, height: 14, borderRadius: 4, background: '#e5e5e5', animation: 'pulse 1.5s ease-in-out infinite' }} />
                        ) : est ? (
                          <>
                            <div style={{ fontWeight: 700, fontSize: 15, color: isSelected ? colors.brand.orange : '#1a1a1a' }}>
                              {fmtPrice(est.estimated_fare_cup, est.estimated_fare_trc)}
                            </div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>
                              ~{Math.ceil((est.estimated_duration_s || 0) / 60)} min
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: 13, color: '#d1d5db' }}>—</div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ═══ Delivery form ═══ */}
            {serviceType === 'mensajeria' && (
              <div style={{ marginBottom: 16, padding: 16, borderRadius: 12, border: '2px solid ' + colors.brand.orange, background: 'linear-gradient(135deg, rgba(255,77,0,0.03), rgba(255,77,0,0.08))' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 20 }}>📦</span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#1a1a1a' }}>Datos del envío</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Completa los datos del destinatario</div>
                  </div>
                </div>

                {/* Delivery vehicle selector */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Vehículo *</label>
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    {DELIVERY_VEHICLES.map((v) => {
                      const sel = deliveryVehicle === v.slug;
                      return (
                        <button key={v.slug} type="button" onClick={() => { setDeliveryVehicle(v.slug); setAllEstimates({}); }}
                          style={{ flex: 1, padding: '8px 6px', borderRadius: 10, border: sel ? '2px solid ' + colors.brand.orange : '1px solid #e5e5e5', background: sel ? '#FFF5F0' : '#fff', cursor: 'pointer', textAlign: 'center' }}>
                          <Image source={v.img} style={{ width: 28, height: 28, marginBottom: 2 }} resizeMode="contain" />
                          <div style={{ fontSize: 11, fontWeight: sel ? 700 : 500, color: sel ? colors.brand.orange : '#6b7280' }}>{v.label}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Recipient name */}
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Destinatario *</label>
                  <input type="text" value={deliveryName} onChange={(e) => setDeliveryName(e.target.value)} placeholder="Nombre completo"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e5e5', fontSize: 13, marginTop: 4, boxSizing: 'border-box', outline: 'none' }} />
                </div>

                {/* Recipient phone */}
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Teléfono *</label>
                  <input type="tel" value={deliveryPhone} onChange={(e) => setDeliveryPhone(e.target.value)} placeholder="+53 5XXXXXXX"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e5e5', fontSize: 13, marginTop: 4, boxSizing: 'border-box', outline: 'none' }} />
                </div>

                {/* Package category */}
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Tipo de paquete</label>
                  <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                    {DELIVERY_CATS.map((cat) => {
                      const sel = deliveryCategory === cat.value;
                      return (
                        <button key={cat.value} type="button" onClick={() => setDeliveryCategory(cat.value)}
                          style={{ padding: '6px 10px', borderRadius: 8, border: sel ? '2px solid ' + colors.brand.orange : '1px solid #e5e5e5', background: sel ? '#FFF5F0' : '#fff', cursor: 'pointer', fontSize: 12 }}>
                          {cat.icon} {cat.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Instructions */}
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Instrucciones</label>
                  <input type="text" value={deliveryInstructions} onChange={(e) => setDeliveryInstructions(e.target.value)} placeholder="Instrucciones especiales"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e5e5', fontSize: 13, marginTop: 4, boxSizing: 'border-box', outline: 'none' }} />
                </div>

                {/* Client accompanies toggle */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={clientAccompanies} onChange={(e) => setClientAccompanies(e.target.checked)} />
                  <span style={{ fontWeight: 500 }}>Voy con el envío</span>
                </label>
              </div>
            )}

            {/* ═══ Fare estimate card ═══ */}
            <div style={{
              padding: 16, borderRadius: 12, marginBottom: 16,
              border: selectedEstimate ? '2px solid ' + colors.brand.orange : '1px solid #e5e5e5',
              background: selectedEstimate ? '#FFF5F0' : '#fff',
              opacity: selectedEstimate ? 1 : 0.6,
            }}>
              {!selectedEstimate && (
                <p style={{ textAlign: 'center', fontSize: 13, color: '#9ca3af', margin: 0, padding: '8px 0' }}>
                  Selecciona origen y destino para ver el estimado
                </p>
              )}
              {selectedEstimate && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontSize: 13, color: '#6b7280' }}>Tarifa estimada</span>
                    <div style={{ textAlign: 'right' }}>
                      {promoResult?.valid && promoResult.discount > 0 ? (
                        <>
                          <span style={{ fontSize: 15, fontWeight: 600, color: '#9ca3af', textDecoration: 'line-through', marginRight: 8 }}>
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
                  <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' }}>
                    <span>{((selectedEstimate.estimated_distance_m || 0) / 1000).toFixed(1)} km</span>
                    <span>{Math.round((selectedEstimate.estimated_duration_s || 0) / 60)} min</span>
                    <span style={{ color: '#9ca3af' }}>~${((selectedEstimate.estimated_fare_cup || 0) / 300).toFixed(2)} USD</span>
                  </div>
                  {(selectedEstimate.surge_multiplier || 0) > 1 && (
                    <span style={{ display: 'inline-block', marginTop: 8, color: '#fff', background: colors.brand.orange, fontWeight: 700, padding: '2px 10px', borderRadius: 12, fontSize: 11 }}>
                      {selectedEstimate.surge_multiplier.toFixed(1)}x surge
                    </span>
                  )}

                  {/* Payment method */}
                  <div style={{ marginTop: 14 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Método de pago</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {(['cash', 'tricicoin'] as const).map((pm) => {
                        const sel = paymentMethod === pm;
                        return (
                          <button key={pm} type="button" onClick={() => setPaymentMethod(pm)}
                            style={{ flex: 1, padding: '8px', borderRadius: 8, border: sel ? '2px solid ' + colors.brand.orange : '1px solid #e5e5e5', background: sel ? '#FFF5F0' : '#fff', cursor: 'pointer', fontSize: 13, fontWeight: sel ? 700 : 400 }}>
                            {pm === 'cash' ? 'Efectivo' : 'TriciCoin'}
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
              <label style={{ fontSize: 13, fontWeight: 600, color: '#6b7280' }}>Código promocional</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <input
                  type="text"
                  value={promoCode}
                  onChange={(e) => { setPromoCode(e.target.value.toUpperCase()); setPromoResult(null); }}
                  placeholder="Ingresa un código"
                  disabled={promoResult?.valid === true}
                  style={{
                    flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', outline: 'none',
                    border: promoResult?.valid ? '2px solid #22c55e' : promoResult?.valid === false ? '2px solid #ef4444' : '1px solid #e5e5e5',
                    background: promoResult?.valid ? 'rgba(34,197,94,0.05)' : '#fff',
                  }}
                />
                {promoResult?.valid ? (
                  <button type="button" onClick={() => { setPromoCode(''); setPromoResult(null); }}
                    style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e5e5', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#6b7280' }}>
                    Quitar
                  </button>
                ) : (
                  <button type="button" onClick={handleApplyPromo}
                    disabled={!promoCode.trim() || !selectedEstimate || promoValidating}
                    style={{
                      padding: '8px 16px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', cursor: (!promoCode.trim() || !selectedEstimate || promoValidating) ? 'not-allowed' : 'pointer',
                      background: (!promoCode.trim() || !selectedEstimate || promoValidating) ? '#d1d5db' : colors.brand.orange,
                      color: '#fff',
                    }}>
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
                <span style={{ fontSize: 13, fontWeight: 600 }}>Programar viaje</span>
              </label>
              {isScheduled && (
                <input
                  type="datetime-local"
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
                  min={new Date().toISOString().slice(0, 16)}
                  style={{ width: '100%', marginTop: 8, padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e5e5', fontSize: 13, boxSizing: 'border-box' }}
                />
              )}
            </div>

            {/* Error */}
            {error && (
              <p style={{ fontSize: 13, color: '#ef4444', marginBottom: 12, padding: '8px 12px', backgroundColor: 'rgba(239,68,68,0.05)', borderRadius: 8, border: '1px solid rgba(239,68,68,0.2)' }}>
                {error}
              </p>
            )}

            {/* ═══ Request button ═══ */}
            <button
              type="button"
              onClick={handleRequest}
              disabled={isRequesting || !selectedEstimate}
              style={{
                width: '100%', padding: 14, borderRadius: 12, border: 'none',
                background: (!selectedEstimate || isRequesting) ? '#d1d5db' : colors.brand.orange,
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
            padding: '14px 20px', borderTop: '1px solid #e5e5e5',
            background: 'linear-gradient(135deg, #FF4D00, #FF8A5C)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontWeight: 500 }}>TriciCoin</span>
            <span style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>T$ {(balance / 100).toFixed(2)}</span>
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

  // Init ride state from DB
  useRideInit();

  // Share rider location during pickup phase (G1)
  useRiderLocationSharing();

  const flowStep = useRideStore((s) => s.flowStep);

  // Crossfade animation between flow steps
  const flowFadeAnim = useRef(new Animated.Value(1)).current;
  const prevFlowStepRef = useRef(flowStep);

  useEffect(() => {
    if (prevFlowStepRef.current !== flowStep) {
      prevFlowStepRef.current = flowStep;
      // Fade out then fade in
      Animated.timing(flowFadeAnim, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }).start(() => {
        Animated.timing(flowFadeAnim, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }).start();
      });
    }
  }, [flowStep, flowFadeAnim]);

  // Onboarding overlay — shows once on first app launch
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem('@tricigo/onboarding_completed').then((v) => {
      if (!v) setShowOnboarding(true);
    });
  }, []);

  // For non-idle flow steps, use the original Screen wrapper
  if (flowStep !== 'idle') {
    return (
      <Screen bg="white" padded scroll>
        <Animated.View style={{ opacity: flowFadeAnim, flex: 1 }}>
          {flowStep === 'selecting' && <SelectingView />}
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
  const setFlowStep = useRideStore((s) => s.setFlowStep);
  const setDropoff = useRideStore((s) => s.setDropoff);
  const setPickup = useRideStore((s) => s.setPickup);
  const setPrefetchedPickup = useRideStore((s) => s.setPrefetchedPickup);
  const { requestEstimate } = useRideActions();
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

  // Check location permission + pre-fetch pickup address on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted') {
          setLocationDenied(true);
          return;
        }
        // Pre-fetch: get last known position + reverse geocode in background
        const pos = await Location.getLastKnownPositionAsync();
        if (!pos || cancelled) return;
        const loc = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        const address = await reverseGeocode(loc.latitude, loc.longitude);
        if (!cancelled && address) {
          setPrefetchedPickup({ address, location: loc });
        }
      } catch {
        // Silently ignore — don't crash
      }
    })();
    return () => { cancelled = true; };
  }, [setPrefetchedPickup]);

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

  // U2.1: Live driver availability pulse
  const [driverCount, setDriverCount] = useState<number | null>(null);

  useEffect(() => {
    const fetchDriverCount = async () => {
      try {
        const { count } = await getSupabaseClient()
          .from('driver_profiles')
          .select('*', { count: 'exact', head: true })
          .eq('is_online', true)
          .gt('last_heartbeat_at', new Date(Date.now() - 5 * 60 * 1000).toISOString());
        setDriverCount(count ?? 0);
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
    setFlowStep('selecting');
  }, [setDropoff, setFlowStep]);

  // U1.1: One-tap booking — set pickup (current location) + dropoff, jump to estimate → reviewing
  const handleOneTapPrediction = useCallback(async (pred: PredictedDestination) => {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') {
        // Fall back to old behavior if no location permission
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
      // requestEstimate will transition to 'reviewing' on success
      requestEstimate();
    } catch {
      // Fallback: just go to selecting view
      handleRecentTap({ address: pred.address, latitude: pred.latitude, longitude: pred.longitude });
    }
  }, [handleRecentTap, setPickup, setDropoff, requestEstimate]);

  const insets = useSafeAreaInsets();

  if (initialLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#f5f5f5' }}>
        <View style={{ flex: 1, backgroundColor: '#e5e7eb' }} />
        <View style={idleStyles.bottomPanel}>
          <Skeleton width="60%" height={28} style={{ marginBottom: 12 }} />
          <Skeleton width="100%" height={52} style={{ borderRadius: 12, marginBottom: 12 }} />
          <SkeletonCard />
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* ── Fullscreen Map Background ── */}
      {MapboxGL ? (
        <MapboxGL.MapView
          style={StyleSheet.absoluteFillObject}
          styleURL="mapbox://styles/mapbox/streets-v12"
          attributionEnabled={false}
          logoEnabled={false}
        >
          <MapboxGL.Camera
            centerCoordinate={[-82.3666, 23.1136]}
            zoomLevel={14}
            animationMode="flyTo"
          />
        </MapboxGL.MapView>
      ) : (
        <View style={[StyleSheet.absoluteFillObject, { backgroundColor: '#e5e7eb' }]} />
      )}

      {/* ── Floating Search Bar (top) ── */}
      <View style={[idleStyles.searchBarContainer, { top: insets.top + 12 }]}>
        <Pressable
          style={idleStyles.searchBar}
          onPress={() => setFlowStep('selecting')}
          accessibilityRole="search"
          accessibilityLabel={t('home.where_to')}
          accessibilityHint={t('a11y.opens_destination', { ns: 'common' })}
        >
          <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.brand.orange, marginRight: 12 }} />
          <Text variant="body" color="tertiary" style={{ flex: 1 }}>
            {t('home.where_to')}
          </Text>
          <Ionicons name="search" size={20} color={colors.neutral[400]} />
        </Pressable>
      </View>

      {/* ── Driver Count Badge (top-right, below search bar) ── */}
      {driverCount !== null && driverCount > 0 && (
        <View style={[idleStyles.driverBadge, { top: insets.top + 72 }]}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#22C55E', marginRight: 6 }} />
          <Text variant="caption" style={{ color: '#fff', fontWeight: '600', fontSize: 12 }}>
            {t('home.drivers_active', { count: driverCount })}
          </Text>
        </View>
      )}

      {/* ── Notification Bell (top-right, next to search) ── */}
      {notifCenterEnabled && (
        <Pressable
          onPress={() => router.push('/notifications')}
          style={[idleStyles.notifBell, { top: insets.top + 20 }]}
          accessibilityRole="button"
          accessibilityLabel={unreadCount > 0 ? `${t('notifications.title')}, ${t('a11y.unread_count', { ns: 'common', count: unreadCount })}` : t('notifications.title')}
        >
          <Ionicons
            name={unreadCount > 0 ? 'notifications' : 'notifications-outline'}
            size={22}
            color={colors.neutral[700]}
          />
          {unreadCount > 0 && (
            <View style={idleStyles.notifBadge}>
              <Text variant="caption" style={{ color: '#fff', fontSize: 9, fontWeight: '700' }}>
                {unreadCount > 99 ? '99+' : unreadCount}
              </Text>
            </View>
          )}
        </Pressable>
      )}

      {/* ── Location permission denied banner (floating) ── */}
      {locationDenied && (
        <Pressable
          onPress={async () => {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status === 'granted') setLocationDenied(false);
          }}
          style={[idleStyles.locationBanner, { top: insets.top + 72 }]}
        >
          <Ionicons name="location-outline" size={18} color="#D97706" />
          <Text variant="caption" style={{ color: '#92400E', flex: 1, marginLeft: 8, fontWeight: '600' }}>
            {t('home.location_denied_title', { defaultValue: 'Ubicación desactivada' })}
          </Text>
          <Ionicons name="chevron-forward" size={14} color="#D97706" />
        </Pressable>
      )}

      {/* ── Bottom Panel (fixed card above tab bar) ── */}
      <View style={idleStyles.bottomPanel}>
        {/* Greeting + Balance row */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <Text variant="bodySmall" color="secondary" style={{ fontWeight: '600' }}>
            {t('home.greeting', { name: user?.full_name ?? 'Viajero' })}
          </Text>
          <BalanceBadge balance={walletBalance} size="sm" coinIcon={tricoinSmall} />
        </View>

        {/* Pending split invites */}
        <SplitInviteCard />

        {/* Predicted destinations — horizontal scroll cards */}
        {predictions.length > 0 && (
          <View style={{ marginBottom: 12 }}>
            <Text variant="caption" color="secondary" style={{ marginBottom: 8 }}>
              {t('prediction.suggested_for_you', { defaultValue: 'Sugerencias para ti' })}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {predictions.slice(0, 3).map((pred, idx) => (
                <Pressable
                  key={`pred-${idx}`}
                  style={idleStyles.predictionCard}
                  onPress={() => handleOneTapPrediction(pred)}
                  accessibilityRole="button"
                  accessibilityLabel={pred.address}
                >
                  <View style={idleStyles.predictionIcon}>
                    <Ionicons
                      name={pred.reason === 'time_pattern' ? 'time-outline' : pred.reason === 'frequent' ? 'star' : 'navigate-outline'}
                      size={18}
                      color={colors.brand.orange}
                    />
                  </View>
                  <Text variant="caption" numberOfLines={2} style={{ color: '#1a1a1a', flex: 1 }}>
                    {pred.address}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Service types — horizontal scroll */}
        <Text variant="bodySmall" color="secondary" style={{ fontWeight: '600', marginBottom: 8 }}>
          {t('home.services', { defaultValue: 'Servicios' })}
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="radiogroup">
          {(['moto_standard', 'triciclo_basico', 'auto_standard', 'auto_confort', 'mensajeria'] as const).map((slug) => (
            <View key={slug} style={{ width: 72, marginRight: 10 }}>
              <ServiceTypeCard
                slug={slug}
                name={t(`service_type.${slug}` as const)}
                icon={vehicleSelectionImages[slug]}
              />
            </View>
          ))}
        </ScrollView>
      </View>
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

// ── Selecting View ─────────────────────────────────────────

function SelectingView() {
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);
  const {
    draft,
    prefetchedPickup,
    allFareEstimates,
    setPickup,
    setDropoff,
    swapPickupDropoff,
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
  const [selectingDetailsExpanded, setSelectingDetailsExpanded] = useState(false);
  const [mapPickerMode, setMapPickerMode] = useState<'pickup' | 'dropoff' | null>(null);

  // Nearest driver ETA
  const nearbyVehicles = useNearbyVehicles(
    draft.pickup?.location?.latitude,
    draft.pickup?.location?.longitude,
  );
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
      if (!(v.vehicle_type in result) || etaMin < result[v.vehicle_type]) {
        result[v.vehicle_type] = etaMin;
      }
    }
    return result;
  }, [draft.pickup?.location, nearbyVehicles]);

  // UBER-4.4: Load saved payment method on mount
  useEffect(() => {
    AsyncStorage.getItem('last_payment_method').then((saved) => {
      if (saved && (saved === 'cash' || saved === 'tricicoin') && !draft.paymentMethod) {
        setPaymentMethod(saved);
      }
    }).catch(() => {});
  }, []);

  // UBER-4.4: Persist payment method when it changes
  const handlePaymentMethodChange = useCallback((method: 'cash' | 'tricicoin') => {
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

  // Load saved locations from customer profile
  useEffect(() => {
    if (!user?.id) return;
    customerService.ensureProfile(user.id).then((cp) => {
      setSavedLocations(cp.saved_locations ?? []);
    }).catch(() => {});
  }, [user?.id]);

  // Auto-populate pickup from pre-fetched location (if empty)
  useEffect(() => {
    if (!draft.pickup && prefetchedPickup) {
      setPickup(prefetchedPickup.address, prefetchedPickup.location);
    }
  }, [prefetchedPickup]);

  const isDelivery = draft.serviceType === 'mensajeria';
  const deliveryValid = !isDelivery || (
    draft.delivery.packageDescription.trim() &&
    draft.delivery.recipientName.trim() &&
    draft.delivery.recipientPhone.trim() &&
    !!draft.delivery.deliveryVehicleType
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
        onSelect={(address, location) => {
          if (!isValidCoordinate(location.latitude, location.longitude)) {
            Toast.show({ type: 'error', text1: t('errors.invalid_coordinates', { ns: 'common', defaultValue: 'Ubicación inválida. Selecciona otra dirección.' }) });
            return;
          }
          setPickup(address, location);
        }}
        savedLocations={savedLocations}
        recentAddresses={recentAddresses}
        showUseMyLocation
        onPickOnMap={() => setMapPickerMode('pickup')}
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

      {/* Nearest driver ETA indicator */}
      {nearestDriverETA != null && draft.pickup && (
        <View className="flex-row items-center px-3 py-2 mt-1 rounded-lg bg-green-50 border border-green-200">
          <Ionicons name="car-outline" size={16} color="#16a34a" />
          <Text variant="caption" style={{ color: '#16a34a', marginLeft: 6 }}>
            {t('ride.nearest_driver_eta', {
              defaultValue: 'Conductor más cercano a ~{{minutes}} min',
              minutes: nearestDriverETA,
            })}
          </Text>
        </View>
      )}

      {/* Swap button — only visible when both pickup and dropoff are set */}
      {draft.pickup && draft.dropoff ? (
        <View className="items-center py-1">
          <Pressable
            onPress={() => { swapPickupDropoff(); triggerSelection(); }}
            className="bg-neutral-100 rounded-full p-2"
            hitSlop={8}
            accessibilityLabel={t('ride.swap_locations', { defaultValue: 'Intercambiar origen y destino' })}
          >
            <Ionicons name="swap-vertical" size={20} color={colors.brand.orange} />
          </Pressable>
        </View>
      ) : (
        <View className="h-2" />
      )}

      {/* Dropoff — address search with presets */}
      <Text variant="label" className="mb-1">
        {t('ride.dropoff')}
      </Text>
      <AddressSearchInput
        placeholder={t('ride.enter_dropoff', { defaultValue: 'Destino' })}
        selectedAddress={draft.dropoff?.address ?? null}
        onSelect={(address, location) => {
          if (!isValidCoordinate(location.latitude, location.longitude)) {
            Toast.show({ type: 'error', text1: t('errors.invalid_coordinates', { ns: 'common', defaultValue: 'Ubicación inválida. Selecciona otra dirección.' }) });
            return;
          }
          setDropoff(address, location);
        }}
        savedLocations={savedLocations}
        recentAddresses={recentAddresses}
        predictions={predictions}
        onPickOnMap={() => setMapPickerMode('dropoff')}
      />

      <View className="h-4" />

      {/* Service type — vertical list cards matching web design */}
      <Text variant="label" className="mb-2">{t('ride.service_label', { defaultValue: 'Servicio' })}</Text>
      <View className="mb-4 gap-2" accessibilityRole="radiogroup">
        {(['moto_standard', 'triciclo_basico', 'auto_standard', 'auto_confort', 'mensajeria'] as ServiceTypeSlug[]).map((slug) => {
          const meta = SERVICE_META[slug];
          const isSelected = draft.serviceType === slug || (slug === 'triciclo_basico' && draft.serviceType === 'triciclo_cargo');
          const est = allFareEstimates?.[slug];
          const vt = serviceTypeToVehicleType(slug);
          const pickupEta = vt ? etaByVehicleType[vt] : null;

          return (
            <Pressable
              key={slug}
              onPress={() => { setServiceType(slug); triggerSelection(); }}
              className={`flex-row items-center justify-between px-4 py-3 rounded-xl border ${
                isSelected
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                  : 'border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900'
              }`}
              accessibilityRole="radio"
              accessibilityLabel={meta?.label ?? slug}
              accessibilityState={{ selected: isSelected }}
            >
              <View className="flex-row items-center flex-1">
                <Image
                  source={vehicleSelectionImages[slug]}
                  style={{ width: 40, height: 40 }}
                  resizeMode="contain"
                />
                <View className="ml-3 flex-1">
                  <Text variant="body" className="font-semibold">
                    {meta?.label ?? slug}
                  </Text>
                  <View className="flex-row items-center mt-0.5">
                    <Text variant="caption" color="tertiary">
                      {slug === 'mensajeria' ? t('ride.delivery_label', { defaultValue: 'Según vehículo' }) : meta?.desc}
                    </Text>
                    {pickupEta != null && (
                      <Text variant="caption" style={{ color: '#16a34a', fontWeight: '600', marginLeft: 6 }}>
                        · {pickupEta} min
                      </Text>
                    )}
                  </View>
                </View>
              </View>
              <View className="items-end">
                {est ? (
                  <>
                    <Text
                      variant="body"
                      className="font-bold"
                      color={isSelected ? 'accent' : 'primary'}
                    >
                      {formatFare(est.estimated_fare_cup, est.estimated_fare_trc)}
                    </Text>
                    {est.estimated_duration_s != null && est.estimated_duration_s > 0 && (
                      <Text variant="caption" color="tertiary">
                        ~{Math.ceil(est.estimated_duration_s / 60)} min
                      </Text>
                    )}
                  </>
                ) : isFareEstimating ? (
                  <View style={{ width: 60, height: 14, borderRadius: 4, backgroundColor: '#e5e7eb' }} />
                ) : (
                  <Text variant="caption" color="tertiary">—</Text>
                )}
              </View>
            </Pressable>
          );
        })}
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
              {t('ride.package_category', { defaultValue: 'Categoría' })}
            </Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-3">
            <View className="flex-row gap-2">
              {PACKAGE_CATEGORIES.map((cat) => {
                const emoji = { documentos: '\u{1F4C4}', comida: '\u{1F354}', paquete_pequeno: '\u{1F4E6}', paquete_grande: '\u{1F4EB}', fragil: '\u26A0\uFE0F' }[cat] ?? '';
                return (
                  <Pressable
                    key={cat}
                    className={`px-3 py-1.5 rounded-full border ${
                      draft.delivery.packageCategory === cat
                        ? 'bg-primary-500 border-primary-500'
                        : 'bg-neutral-50 border-neutral-200 dark:bg-neutral-800 dark:border-neutral-700'
                    }`}
                    onPress={() => setDeliveryField('packageCategory', cat)}
                  >
                    <Text
                      variant="caption"
                      color={draft.delivery.packageCategory === cat ? 'inverse' : 'secondary'}
                      className="font-medium"
                    >
                      {emoji} {t(`ride.package_cat_${cat}` as const, { defaultValue: cat.replace('_', ' ') })}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
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
          {/* Delivery vehicle selector */}
          <View className="mb-1">
            <Text variant="caption" color="secondary">
              {t('ride.delivery_vehicle', { defaultValue: 'Vehículo para el envío' })}
              <Text variant="caption" className="text-red-500"> *</Text>
            </Text>
          </View>
          <View className="flex-row gap-2 mb-3 flex-wrap">
            {([
              { type: 'moto' as const, label: 'Moto', slug: 'moto_standard' as ServiceTypeSlug },
              { type: 'triciclo' as const, label: 'Triciclo', slug: 'triciclo_basico' as ServiceTypeSlug },
              { type: 'auto' as const, label: 'Auto', slug: 'auto_standard' as ServiceTypeSlug },
            ]).map((v) => {
              const isVSelected = draft.delivery.deliveryVehicleType === v.type;
              const vEst = allFareEstimates?.[v.slug];
              return (
                <Pressable
                  key={v.type}
                  className={`flex-row items-center px-3 py-2 rounded-xl border ${
                    isVSelected
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                      : 'border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800'
                  }`}
                  onPress={() => setDeliveryField('deliveryVehicleType', v.type)}
                >
                  <Image
                    source={vehicleSelectionImages[v.slug]}
                    style={{ width: 22, height: 22, marginRight: 6 }}
                    resizeMode="contain"
                  />
                  <Text
                    variant="caption"
                    color={isVSelected ? 'accent' : 'secondary'}
                    className="font-semibold"
                  >
                    {v.label}
                  </Text>
                  {vEst && (
                    <Text variant="caption" color="tertiary" className="ml-1" style={{ fontSize: 10 }}>
                      {formatFare(vEst.estimated_fare_cup, vEst.estimated_fare_trc)}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>

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

          {/* Client accompanies toggle */}
          <Pressable
            className={`flex-row items-center mt-3 px-4 py-3 rounded-xl border ${
              draft.delivery.clientAccompanies
                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                : 'border-neutral-200 dark:border-neutral-700'
            }`}
            onPress={() => setDeliveryField('clientAccompanies', !draft.delivery.clientAccompanies)}
          >
            <View
              style={{
                width: 40, height: 22, borderRadius: 11,
                backgroundColor: draft.delivery.clientAccompanies ? colors.brand.orange : '#ccc',
                justifyContent: 'center',
              }}
            >
              <View
                style={{
                  width: 18, height: 18, borderRadius: 9,
                  backgroundColor: '#fff',
                  marginLeft: draft.delivery.clientAccompanies ? 20 : 2,
                }}
              />
            </View>
            <View className="ml-3 flex-1">
              <Text variant="bodySmall" className="font-semibold">
                {t('ride.client_accompanies', { defaultValue: 'Voy con el envío' })}
              </Text>
              <Text variant="caption" color="tertiary">
                {t('ride.client_accompanies_desc', { defaultValue: 'Acompaña tu paquete sin costo adicional' })}
              </Text>
            </View>
          </Pressable>
        </Card>
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
                onPress={() => handlePaymentMethodChange(pm)}
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

      {/* UX-1: Collapsible secondary options toggle */}
      <Pressable
        className="py-3 items-center"
        onPress={() => setSelectingDetailsExpanded(!selectingDetailsExpanded)}
      >
        <Text variant="bodySmall" color="accent" className="underline">
          {selectingDetailsExpanded
            ? t('home.fewer_options', { defaultValue: 'Menos opciones' })
            : t('home.more_options', { defaultValue: 'Más opciones' })
          }
        </Text>
      </Pressable>

      {/* UX-1: Collapsible secondary options */}
      {selectingDetailsExpanded && (
        <>
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
                    onSelect={(address, location) => {
                      if (!isValidCoordinate(location.latitude, location.longitude)) {
                        Toast.show({ type: 'error', text1: t('errors.invalid_coordinates', { ns: 'common', defaultValue: 'Ubicación inválida. Selecciona otra dirección.' }) });
                        return;
                      }
                      updateWaypoint(idx, address, location);
                    }}
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
        </>
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

      {/* Confirm Location on Map — full-screen overlay */}
      {mapPickerMode && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 }}>
          <ConfirmLocationScreen
            mode={mapPickerMode}
            initialLocation={
              mapPickerMode === 'pickup'
                ? draft.pickup?.location ?? null
                : draft.dropoff?.location ?? null
            }
            onConfirm={(address, location) => {
              if (!isValidCoordinate(location.latitude, location.longitude)) {
                Toast.show({ type: 'error', text1: t('errors.invalid_coordinates', { ns: 'common', defaultValue: 'Ubicación inválida. Selecciona otra dirección.' }) });
                setMapPickerMode(null);
                return;
              }
              if (mapPickerMode === 'pickup') {
                setPickup(address, location);
              } else {
                setDropoff(address, location);
              }
              setMapPickerMode(null);
            }}
            onClose={() => setMapPickerMode(null)}
          />
        </View>
      )}
    </View>
  );
}

// ── Reviewing View (BottomSheet) ───────────────────────────

function ReviewingView() {
  const { t } = useTranslation('rider');
  const { isTablet } = useResponsive();
  const { draft, fareEstimate, allFareEstimates, setFlowStep, setServiceType, isLoading, isFareEstimating, error, promoCode, promoResult, setPromoCode, splits, setInsurance, setRidePreferences, activeRide } = useRideStore();
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
        fare: formatCurrency(fareEstimate.estimated_fare_cup),
        eta: Math.ceil((fareEstimate.estimated_duration_s || 0) / 60),
      })
    : t('home.calculating', { defaultValue: 'Calculando...' });
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
      <View className="h-3" />

      {/* UBER-1.1: Recommended service PRIMARY card */}
      <View
        className="border-2 border-primary-500 rounded-xl p-4 mb-3 relative"
        style={{ shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3, backgroundColor: '#fff' }}
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
            {fareEstimate.exchange_rate_usd_cup > 0 && (
              <Text variant="caption" color="tertiary">
                ~${(fareEstimate.estimated_fare_cup / fareEstimate.exchange_rate_usd_cup).toFixed(2)} USD
              </Text>
            )}
          </View>
        </View>
        {/* Distance · Per-km rate · Exchange rate */}
        <View className="flex-row flex-wrap items-center mt-2 pt-2 border-t border-neutral-100 dark:border-neutral-800 gap-x-3 gap-y-1">
          {fareEstimate.estimated_distance_m > 0 && (
            <Text variant="caption" color="secondary">
              {(fareEstimate.estimated_distance_m / 1000).toFixed(1)} km
            </Text>
          )}
          {fareEstimate.per_km_rate_cup > 0 && (
            <Text variant="caption" color="tertiary">
              {formatFare(fareEstimate.per_km_rate_cup)}/km
            </Text>
          )}
          {fareEstimate.exchange_rate_usd_cup > 0 && (
            <Text variant="caption" color="tertiary">
              1 USD = {formatCurrency(fareEstimate.exchange_rate_usd_cup)} CUP
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
              const est = allFareEstimates?.[slug];
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

      {/* Surge pricing alert (always visible when active) */}
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
              surgeLabel={fareEstimate.surge_multiplier && fareEstimate.surge_multiplier > 1 ? t('ride.surge_active', { defaultValue: 'Tarifa dinámica' }) : undefined}
              surgeType={fareEstimate.surge_type}
              totalCup={fareEstimate.estimated_fare_cup}
              totalTrc={fareEstimate.estimated_fare_trc}
              totalLabel={t('ride.estimated_fare')}
              discountTrc={discount} /* discountAmount is in CUP; TRC = CUP 1:1 — discount applies to base fare only, before insurance */
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

          {/* U1.4: Fare range context */}
          {fareEstimate.estimated_fare_cup > 0 && (
            <Text variant="caption" color="tertiary" className="text-center mt-2 mb-4" style={{ color: colors.neutral[500] }}>
              {paymentMethod === 'tricicoin'
                ? `Este viaje suele costar ${formatTRC(Math.max(0, Math.round((fareEstimate.estimated_fare_trc ?? fareEstimate.estimated_fare_cup) * 0.85) - discount))} – ${formatTRC(Math.max(0, Math.round((fareEstimate.estimated_fare_trc ?? fareEstimate.estimated_fare_cup) * 1.15) - discount))}`
                : t('home.usual_fare_range', {
                    low: Math.max(0, Math.round(fareEstimate.estimated_fare_cup * 0.85) - discount).toLocaleString(),
                    high: Math.max(0, Math.round(fareEstimate.estimated_fare_cup * 1.15) - discount).toLocaleString(),
                    defaultValue: 'Este viaje suele costar ₧{{low}} - ₧{{high}}',
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

// ── Searching View ─────────────────────────────────────────

function SearchingView() {
  const { t } = useTranslation('rider');
  const { isTablet } = useResponsive();
  const { isLoading, error, activeRide } = useRideStore();
  const { cancelRide, requestEstimate } = useRideActions();
  const routeCoordinates = useRoutePolyline(
    activeRide?.pickup_location ?? null,
    activeRide?.dropoff_location ?? null,
  );

  // ── Interactive searching: real-time driver presence ──
  const {
    searchingDrivers,
    acceptedDriver,
    isAcceptAnimating,
  } = useSearchingDrivers(activeRide?.id ?? null);

  // UBER-2.1: 5-phase progressive search messages with fade transitions
  const [searchPhase, setSearchPhase] = useState(0);
  const searchFadeAnim = useRef(new Animated.Value(1)).current;

  const fadeAndSetPhase = useCallback((phase: number) => {
    Animated.timing(searchFadeAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
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

  const searchMessage = SEARCH_MESSAGES[searchPhase] ?? SEARCH_MESSAGES[0];

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

      {/* Interactive driver presence mini-card (replaces static ActivityIndicator) */}
      {!acceptedDriver && (
        <DriverInfoMiniCard
          drivers={searchingDrivers}
          isSearching={!searchTimedOut}
        />
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
            <Text variant="bodySmall" color="secondary" className="mb-4 text-center">
              {searchMessage}
            </Text>
          </Animated.View>

          {/* UBER-2.1: Thin progress bar showing search timeout */}
          <View className="w-full px-8 mb-6">
            <View style={{ height: 3, backgroundColor: '#E5E7EB', borderRadius: 2, overflow: 'hidden' }}>
              <Animated.View
                style={{
                  height: '100%',
                  backgroundColor: colors.brand.orange,
                  borderRadius: 2,
                  width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
                }}
              />
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
