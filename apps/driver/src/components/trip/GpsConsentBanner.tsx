/**
 * GpsConsentBanner — Midnight Ember edition (PR-B).
 *
 * BUG-246 flow: when the driver loses GPS, three states are possible:
 *   - `unavailable`         → driver reported GPS lost; rider hasn't decided yet
 *   - `rider_consented`     → rider accepted to continue without GPS
 *   - (initial / no status) → driver still hasn't notified rider; show CTA
 *
 * When GPS comes back while the ride was flagged `unavailable`, the
 * component fires a one-shot `reportGpsRecovered` ping. (Latched behind
 * `recoveredFiredRef`; see PR-A commit history for the bug fix.)
 *
 * v2 tokenization: 3 ad-hoc colors (#10B981 / #F59E0B / #EF4444) and
 * their 10%-tint backgrounds collapse onto the semantic state tokens.
 * The "Avisarle al pasajero" CTA uses `state.danger` solid.
 */
import React, { useEffect, useRef } from 'react';
import { View, Pressable } from 'react-native';
import Toast from 'react-native-toast-message';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { driverService } from '@tricigo/api';
import { midnightEmber } from '@tricigo/theme';

interface GpsConsentBannerProps {
  rideId: string;
  /** Null when device has no fix; tells us we're in the "GPS broken" lane. */
  driverLocation: { latitude: number; longitude: number } | null;
  /** Server-side state machine: 'unavailable' | 'rider_consented' | etc. */
  driverGpsStatus: string | null | undefined;
  rideStatus: string;
}

/** Append `1F` (≈12% alpha) to a hex color so it reads as a tint. */
function tinted(color: string): string {
  return `${color}1F`;
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

  const consented = driverGpsStatus === 'rider_consented';
  const waiting = driverGpsStatus === 'unavailable';
  const accent = consented
    ? midnightEmber.state.success
    : waiting
      ? midnightEmber.state.warning
      : midnightEmber.state.danger;

  return (
    <View
      style={{
        marginBottom: 8,
        padding: 10,
        borderRadius: 10,
        backgroundColor: tinted(accent),
        borderWidth: 1,
        borderColor: `${accent}66`, // ~40%
      }}
    >
      {consented ? (
        <Text
          variant="caption"
          style={{ color: accent, fontWeight: '600', textAlign: 'center' }}
        >
          {t('trip.gps_consented', { defaultValue: '✓ El pasajero aceptó continuar sin GPS' })}
        </Text>
      ) : waiting ? (
        <Text
          variant="caption"
          style={{ color: accent, fontWeight: '600', textAlign: 'center' }}
        >
          {t('trip.gps_waiting_rider', { defaultValue: '⏳ Esperando respuesta del pasajero…' })}
        </Text>
      ) : (
        <View>
          <Text
            variant="caption"
            style={{ color: accent, fontWeight: '600', textAlign: 'center', marginBottom: 6 }}
          >
            {t('trip.gps_unavailable_warning', { defaultValue: '⚠️ GPS no disponible' })}
          </Text>
          <Pressable
            onPress={async () => {
              try {
                await driverService.reportGpsUnavailable(rideId);
                Toast.show({
                  type: 'info',
                  text1: t('trip.gps_notify_rider_sent', { defaultValue: 'Le avisamos al pasajero' }),
                  text2: t('trip.gps_notify_rider_hint', { defaultValue: 'Espera su respuesta para continuar' }),
                });
              } catch {
                Toast.show({ type: 'error', text1: t('trip.gps_notify_rider_failed', { defaultValue: 'No se pudo notificar' }) });
              }
            }}
            style={{
              alignSelf: 'center',
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: midnightEmber.radius.input,
              backgroundColor: midnightEmber.state.danger,
            }}
          >
            <Text
              variant="caption"
              style={{ color: midnightEmber.map.text.onAccent, fontWeight: '700' }}
            >
              {t('trip.gps_notify_rider', { defaultValue: 'Avisarle al pasajero' })}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
