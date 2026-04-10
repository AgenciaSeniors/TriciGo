import React, { useState, useCallback } from 'react';
import { View, Platform } from 'react-native';
import { useTranslation } from '@tricigo/i18n';
import { useRideStore } from '@/stores/ride.store';
import { useDriverPositionWithCache } from '@/hooks/useDriverPosition';
import { useRoutePolyline } from '@/hooks/useRoutePolyline';
import { useDriverToPickupRoute } from '@/hooks/useDriverToPickupRoute';
import { useETA } from '@/hooks/useETA';
import { rideService } from '@tricigo/api/services/ride';
import { WebMapView } from './WebMapView';
import { getInitials, buildShareUrl } from '@tricigo/utils';
import { colors } from '@tricigo/theme';

/* ── CSS keyframes for active ride animations ── */
const WEB_ACTIVE_CSS = `
  @keyframes war-fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes war-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
`;

interface WebActiveRideViewProps {
  onReset: () => void;
}

export function WebActiveRideView({ onReset }: WebActiveRideViewProps) {
  const { t } = useTranslation('rider');
  const activeRide = useRideStore((s) => s.activeRide);
  const rideWithDriver = useRideStore((s) => s.rideWithDriver);
  const activeRideId = activeRide?.id ?? null;

  // Normalize pickup/dropoff — ride from createRide may have lat/lng fields instead of GeoPoint
  const pickupLocation = activeRide?.pickup_location?.latitude
    ? activeRide.pickup_location
    : activeRide?.pickup_lat && activeRide?.pickup_lng
      ? { latitude: activeRide.pickup_lat as number, longitude: activeRide.pickup_lng as number }
      : null;
  const dropoffLocation = activeRide?.dropoff_location?.latitude
    ? activeRide.dropoff_location
    : activeRide?.dropoff_lat && activeRide?.dropoff_lng
      ? { latitude: activeRide.dropoff_lat as number, longitude: activeRide.dropoff_lng as number }
      : null;

  // Live driver position
  const driverPosState = useDriverPositionWithCache(activeRideId);
  const driverPosition = driverPosState.position;

  // Route polylines
  const routeData = useRoutePolyline(
    pickupLocation,
    dropoffLocation,
  );
  const routeGeoPoints = routeData.coordinates;

  // Convert GeoPoint[] to [lat, lng][] tuples for WebMapView
  const routeCoords = routeGeoPoints?.map(
    (p) => [p.latitude, p.longitude] as [number, number],
  );

  const driverToPickupGeoPoints = useDriverToPickupRoute(
    driverPosition,
    pickupLocation,
    activeRide?.status ?? null,
  );

  // Convert GeoPoint[] to [lat, lng][] tuples for WebMapView driverRoute prop
  const driverRoute = driverToPickupGeoPoints?.map(
    (p) => [p.latitude, p.longitude] as [number, number],
  );

  // ETA
  const { etaMinutes } = useETA({
    driverLocation: driverPosition,
    pickupLocation: pickupLocation,
    dropoffLocation: dropoffLocation,
    rideStatus: activeRide?.status ?? null,
  });

  // Share handler
  const [isSharing, setIsSharing] = useState(false);

  const handleShare = useCallback(async () => {
    if (!activeRide) return;
    setIsSharing(true);
    try {
      let token = activeRide.share_token;
      if (!token) {
        token = await rideService.generateShareToken(activeRide.id);
        useRideStore.getState().setActiveRide({ ...activeRide, share_token: token });
      }
      const url = buildShareUrl(token);
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: 'TriciGo', text: t('ride.share_message', { url }), url });
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
      }
    } catch {
      /* user cancelled or unsupported */
    } finally {
      setIsSharing(false);
    }
  }, [activeRide, t]);

  // Status stepper steps
  const steps = ['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress'] as const;
  const currentIdx = steps.indexOf(activeRide?.status as typeof steps[number]);

  // Status header text
  const statusHeader =
    activeRide?.status === 'arrived_at_pickup'
      ? t('ride.driver_arrived')
      : activeRide?.status === 'in_progress'
        ? t('ride.in_progress')
        : t('ride.driver_arriving');

  const font = { fontFamily: 'Montserrat, system-ui, sans-serif' };

  if (Platform.OS !== 'web') return null;

  return (
    <View style={{ flex: 1 }}>
      <div style={{ display: 'flex', flexDirection: 'row', height: '100vh', ...font }}>
        <style dangerouslySetInnerHTML={{ __html: WEB_ACTIVE_CSS }} />

        {/* ═══ LEFT: Map ═══ */}
        <div style={{ flex: 1, position: 'relative', background: '#f0f0f0' }}>
          <WebMapView
            pickup={pickupLocation}
            dropoff={dropoffLocation}
            routeCoords={routeCoords}
            driverRoute={driverRoute}
            style={{ width: '100%', height: '100%' }}
          />

          {/* ETA floating badge on map */}
          {etaMinutes !== null && etaMinutes > 0 && (
            <div style={{
              position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 20px', borderRadius: 999,
              background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(12px)',
              boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
              fontSize: 14, fontWeight: 700, color: '#1a1a1a', zIndex: 10,
              animation: 'war-fadeIn 0.4s ease both',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.brand.orange} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              {etaMinutes === 0 ? '< 1 min' : `~${etaMinutes} min`}
            </div>
          )}
        </div>

        {/* ═══ RIGHT: Sidebar ═══ */}
        <div style={{
          width: 380,
          minWidth: 340,
          maxWidth: 420,
          backgroundColor: '#fff',
          borderLeft: '1px solid #e5e5e5',
          overflowY: 'auto' as const,
          padding: '28px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          ...font,
        }}>

          {/* Status header */}
          <div style={{ marginBottom: 20, animation: 'war-fadeIn 0.3s ease both' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '0.04em', marginBottom: 4 }}>
              {t('ride.eta', { defaultValue: 'Estimated time' })}
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: '#1a1a1a', margin: 0, letterSpacing: '-0.02em' }}>
              {statusHeader}
            </h2>
          </div>

          {/* Status stepper */}
          <div style={{ marginBottom: 20, animation: 'war-fadeIn 0.3s ease both 0.05s' }}>
            {steps.map((step, i) => {
              const isActive = i <= currentIdx;
              const isCurrent = step === activeRide?.status;
              const isLast = i === steps.length - 1;
              return (
                <div key={step} style={{ display: 'flex', alignItems: 'flex-start', marginBottom: isLast ? 0 : 4 }}>
                  {/* Step indicator + connector */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginRight: 10 }}>
                    <div style={{
                      width: 24, height: 24, borderRadius: 12,
                      backgroundColor: isActive ? colors.brand.orange : '#e5e5e5',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: isCurrent ? `2px solid ${colors.brand.orange}` : 'none',
                      boxShadow: isCurrent ? `0 0 0 3px rgba(255,77,0,0.2)` : 'none',
                      transition: 'all 0.3s ease',
                    }}>
                      {isActive && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      )}
                    </div>
                    {!isLast && (
                      <div style={{
                        width: 2, height: 16,
                        backgroundColor: i < currentIdx ? colors.brand.orange : '#e5e5e5',
                        transition: 'background-color 0.3s ease',
                      }} />
                    )}
                  </div>
                  {/* Step label */}
                  <span style={{
                    fontSize: 13,
                    fontWeight: isCurrent ? 700 : 400,
                    color: isActive ? '#1a1a1a' : '#9ca3af',
                    lineHeight: '24px',
                    transition: 'all 0.3s ease',
                  }}>
                    {t(`ride.status_${step}`, { defaultValue: step })}
                  </span>
                </div>
              );
            })}
          </div>

          {/* ETA badge */}
          {etaMinutes !== null && etaMinutes > 0 && (
            <div style={{
              backgroundColor: '#FFF7ED',
              border: '1px solid #FDBA74',
              borderRadius: 10,
              padding: '10px 14px',
              marginBottom: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              animation: 'war-fadeIn 0.3s ease both 0.1s',
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9A3412" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#9A3412' }}>
                {etaMinutes === 0
                  ? t('ride.arriving', { defaultValue: 'Llegando' })
                  : activeRide?.status === 'in_progress'
                    ? t('ride.eta_destination', { minutes: etaMinutes, defaultValue: `Arriving in ~${etaMinutes} min` })
                    : t('ride.eta_driver_arriving', { minutes: etaMinutes, defaultValue: `Arrives in ~${etaMinutes} min` })}
              </span>
            </div>
          )}

          {/* Driver card */}
          {rideWithDriver && (
            <div style={{
              backgroundColor: '#f9fafb',
              borderRadius: 12,
              padding: 16,
              marginBottom: 16,
              border: '1px solid #e5e5e5',
              animation: 'war-fadeIn 0.3s ease both 0.15s',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {/* Avatar */}
                {rideWithDriver.driver_avatar_url ? (
                  <img
                    src={rideWithDriver.driver_avatar_url}
                    alt=""
                    style={{
                      width: 48, height: 48, borderRadius: 24,
                      objectFit: 'cover' as const,
                      border: `2px solid ${colors.brand.orange}`,
                    }}
                  />
                ) : (
                  <div style={{
                    width: 48, height: 48, borderRadius: 24,
                    backgroundColor: colors.brand.orange,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#fff', fontWeight: 700, fontSize: 16,
                  }}>
                    {getInitials(rideWithDriver.driver_name ?? '')}
                  </div>
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#1a1a1a' }}>
                    {rideWithDriver.driver_name}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: '#6b7280' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="#F59E0B" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                    <span>{rideWithDriver.driver_rating?.toFixed(1) ?? '—'}</span>
                    {rideWithDriver.driver_total_rides != null && (
                      <span style={{ marginLeft: 4, fontSize: 11, color: '#9ca3af' }}>
                        ({rideWithDriver.driver_total_rides} trips)
                      </span>
                    )}
                  </div>
                  {(rideWithDriver.vehicle_make || rideWithDriver.vehicle_model) && (
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                      {[rideWithDriver.vehicle_color, rideWithDriver.vehicle_make, rideWithDriver.vehicle_model].filter(Boolean).join(' ')}
                    </div>
                  )}
                  {rideWithDriver.vehicle_plate && (
                    <div style={{
                      display: 'inline-block',
                      backgroundColor: '#1f2937',
                      color: '#fff',
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: 1,
                      marginTop: 4,
                    }}>
                      {rideWithDriver.vehicle_plate}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Route summary (pickup → dropoff) */}
          <div style={{
            borderRadius: 10,
            border: '1px solid #f0f0f0',
            padding: '12px 14px',
            marginBottom: 16,
            animation: 'war-fadeIn 0.3s ease both 0.2s',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 2 }}>
                <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#22c55e' }} />
                <div style={{ width: 1, height: 20, backgroundColor: '#d1d5db', margin: '2px 0' }} />
                <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#ef4444' }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#1a1a1a', marginBottom: 6, lineHeight: '14px' }}>
                  {activeRide?.pickup_address ?? t('ride.pickup')}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#1a1a1a', lineHeight: '14px' }}>
                  {activeRide?.dropoff_address ?? t('ride.dropoff')}
                </div>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, animation: 'war-fadeIn 0.3s ease both 0.25s' }}>
            {/* Share */}
            <button
              onClick={handleShare}
              disabled={isSharing}
              style={{
                flex: 1, padding: '10px 12px',
                backgroundColor: 'rgba(59,130,246,0.08)',
                border: 'none', borderRadius: 8,
                cursor: isSharing ? 'not-allowed' : 'pointer',
                fontWeight: 600, fontSize: 13, color: '#3B82F6',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                opacity: isSharing ? 0.6 : 1,
                ...font,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
              {t('ride.share_trip')}
            </button>
            {/* Chat */}
            <button
              onClick={() => { if (activeRide?.id) window.location.href = `/chat/${activeRide.id}`; }}
              style={{
                flex: 1, padding: '10px 12px',
                backgroundColor: '#f3f4f6',
                border: 'none', borderRadius: 8,
                cursor: 'pointer', fontWeight: 600,
                fontSize: 13, color: '#374151',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                ...font,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              Chat
            </button>
          </div>

          {/* Call driver button */}
          {rideWithDriver?.driver_phone && (
            <a
              href={`tel:${rideWithDriver.driver_phone}`}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '10px 12px',
                backgroundColor: '#f3f4f6',
                borderRadius: 8, marginBottom: 16,
                textDecoration: 'none', color: '#374151',
                fontWeight: 600, fontSize: 13,
                animation: 'war-fadeIn 0.3s ease both 0.3s',
                ...font,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
              {t('ride.call_driver_full', { defaultValue: 'Call driver' })}
            </a>
          )}

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Live tracking indicator */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: '8px 0', marginBottom: 4,
            fontSize: 11, color: '#9ca3af', fontWeight: 500,
            animation: 'war-fadeIn 0.4s ease both 0.35s',
          }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              backgroundColor: '#22c55e',
              animation: 'war-pulse 2s ease-in-out infinite',
            }} />
            {driverPosState.isCached
              ? t('ride.eta_calculating', { defaultValue: 'Calculating...' })
              : t('ride.realtime_tracking', { defaultValue: 'Real-time tracking' })}
          </div>
        </div>
      </div>
    </View>
  );
}
