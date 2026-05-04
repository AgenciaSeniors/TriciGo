/**
 * LiveDistanceHint — extracted from DriverTripView for PR-A.
 *
 * Shows live distance from driver to current target (pickup or dropoff).
 * Replaces a 60-line IIFE that was rendering inline in the parent's JSX.
 *
 * States:
 *   - No driver location → "GPS no disponible" warning
 *   - distance ≤ 100m → "Llegaste al {target}" success
 *   - 100 < distance ≤ 500m → "Estás a Xm/km del {target}" amber bypass-range
 *   - distance > 500m → same neutral
 *
 * Behavior unchanged from inline version. Visual tokens preserved.
 */
import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { haversineDistance } from '@tricigo/utils';

export type LiveDistanceTarget = 'pickup' | 'dropoff';

interface LiveDistanceHintProps {
  driverLocation: { latitude: number; longitude: number } | null;
  target: { latitude: number; longitude: number } | null;
  /** Which side of the trip is the target — drives the localized label. */
  targetType: LiveDistanceTarget;
}

export function LiveDistanceHint({
  driverLocation,
  target,
  targetType,
}: LiveDistanceHintProps) {
  const { t } = useTranslation('driver');

  if (!target) return null;

  if (!driverLocation) {
    return (
      <View style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        padding: 8, marginBottom: 8, borderRadius: 8,
        backgroundColor: 'rgba(239,68,68,0.1)',
        borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)',
      }}>
        <Ionicons name="warning" size={14} color="#EF4444" />
        <Text variant="caption" style={{ color: '#EF4444', marginLeft: 6, fontWeight: '600' }}>
          {t('trip.gps_unavailable', { defaultValue: 'GPS no disponible. Reiniciá la ubicación o contactá soporte.' })}
        </Text>
      </View>
    );
  }

  const distM = haversineDistance(driverLocation, target);
  const targetLabel = targetType === 'pickup'
    ? t('trip.target_pickup', { defaultValue: 'pasajero' })
    : t('trip.target_dropoff', { defaultValue: 'destino' });
  const isClose = distM <= 100;
  const isInBypassRange = distM > 100 && distM <= 500;

  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      paddingVertical: 6, paddingHorizontal: 10, marginBottom: 8, borderRadius: 8,
      backgroundColor: isClose
        ? 'rgba(16,185,129,0.12)'
        : isInBypassRange
          ? 'rgba(245,158,11,0.12)'
          : 'rgba(255,255,255,0.04)',
    }}>
      <Ionicons
        name={isClose ? 'checkmark-circle' : 'location'}
        size={14}
        color={isClose ? '#10B981' : isInBypassRange ? '#F59E0B' : '#9CA3AF'}
      />
      <Text
        variant="caption"
        style={{
          marginLeft: 6,
          color: isClose ? '#10B981' : isInBypassRange ? '#F59E0B' : '#9CA3AF',
          fontWeight: '600',
        }}
      >
        {isClose
          ? t('trip.distance_at_target', { defaultValue: `Llegaste al ${targetLabel}`, target: targetLabel })
          : t('trip.distance_to_target', { defaultValue: `Estás a ${distM < 1000 ? Math.round(distM) + 'm' : (distM/1000).toFixed(1) + 'km'} del ${targetLabel}`, distance: distM < 1000 ? `${Math.round(distM)}m` : `${(distM / 1000).toFixed(1)}km`, target: targetLabel })}
      </Text>
    </View>
  );
}
