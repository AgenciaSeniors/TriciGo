/**
 * GpsConsentBanner — extracted from DriverTripView for PR-A.
 *
 * BUG-246 flow: when the driver loses GPS, three states are possible:
 *   - `unavailable`         → driver reported GPS lost; rider hasn't decided yet
 *   - `rider_consented`     → rider accepted to continue without GPS
 *   - (initial / no status) → driver still hasn't notified rider; show CTA
 *
 * When GPS comes back while the ride was flagged `unavailable`, the
 * component fires a one-shot `reportGpsRecovered` ping. This used to be
 * an inline IIFE in DriverTripView render that triggered a side-effect
 * on every render — now properly fenced by useEffect deps so it only
 * fires once per recovery.
 *
 * Visual + tokens preserved verbatim. Migration to midnightEmber in PR-B.
 */
import React, { useEffect, useRef } from 'react';
import { View, Pressable } from 'react-native';
import Toast from 'react-native-toast-message';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { driverService } from '@tricigo/api';

interface GpsConsentBannerProps {
  rideId: string;
  /** Null when device has no fix; tells us we're in the "GPS broken" lane. */
  driverLocation: { latitude: number; longitude: number } | null;
  /** Server-side state machine: 'unavailable' | 'rider_consented' | etc. */
  driverGpsStatus: string | null | undefined;
  rideStatus: string;
}

export function GpsConsentBanner({
  rideId,
  driverLocation,
  driverGpsStatus,
  rideStatus,
}: GpsConsentBannerProps) {
  const { t } = useTranslation('driver');
  const recoveredFiredRef = useRef(false);

  // GPS recovered side-effect — formerly an inline IIFE in render.
  useEffect(() => {
    if (
      driverLocation &&
      driverGpsStatus === 'unavailable' &&
      !recoveredFiredRef.current
    ) {
      recoveredFiredRef.current = true;
      driverService.reportGpsRecovered(rideId).catch(() => {});
    }
    if (!driverLocation) {
      // Reset the latch when we lose GPS again, so a future recovery
      // can fire the ping cleanly.
      recoveredFiredRef.current = false;
    }
  }, [driverLocation, driverGpsStatus, rideId]);

  // Only render when GPS is broken on a non-canceled ride.
  if (driverLocation || rideStatus === 'canceled') return null;

  return (
    <View style={{
      marginBottom: 8,
      padding: 10,
      borderRadius: 10,
      backgroundColor: driverGpsStatus === 'rider_consented'
        ? 'rgba(16,185,129,0.1)'
        : 'rgba(239,68,68,0.1)',
      borderWidth: 1,
      borderColor: driverGpsStatus === 'rider_consented'
        ? 'rgba(16,185,129,0.4)'
        : 'rgba(239,68,68,0.4)',
    }}>
      {driverGpsStatus === 'rider_consented' ? (
        <Text variant="caption" style={{ color: '#10B981', fontWeight: '600', textAlign: 'center' }}>
          {t('trip.gps_consented', { defaultValue: '✓ El pasajero aceptó continuar sin GPS' })}
        </Text>
      ) : driverGpsStatus === 'unavailable' ? (
        <Text variant="caption" style={{ color: '#F59E0B', fontWeight: '600', textAlign: 'center' }}>
          {t('trip.gps_waiting_rider', { defaultValue: '⏳ Esperando respuesta del pasajero…' })}
        </Text>
      ) : (
        <View>
          <Text variant="caption" style={{ color: '#EF4444', fontWeight: '600', textAlign: 'center', marginBottom: 6 }}>
            {t('trip.gps_unavailable_warning', { defaultValue: '⚠️ GPS no disponible' })}
          </Text>
          <Pressable
            onPress={async () => {
              try {
                await driverService.reportGpsUnavailable(rideId);
                Toast.show({
                  type: 'info',
                  text1: t('trip.gps_notify_rider_sent', { defaultValue: 'Le avisamos al pasajero' }),
                  text2: t('trip.gps_notify_rider_hint', { defaultValue: 'Esperá su respuesta para continuar' }),
                });
              } catch {
                Toast.show({ type: 'error', text1: t('trip.gps_notify_rider_failed', { defaultValue: 'No se pudo notificar' }) });
              }
            }}
            style={{
              alignSelf: 'center',
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: '#EF4444',
            }}
          >
            <Text variant="caption" style={{ color: '#fff', fontWeight: '700' }}>
              {t('trip.gps_notify_rider', { defaultValue: 'Avisarle al pasajero' })}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
