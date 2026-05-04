/**
 * LiveDistanceHint — Midnight Ember edition (PR-B).
 *
 * Shows live distance from driver to current target (pickup or dropoff).
 *
 * States:
 *   - No driver location → "GPS no disponible" warning (state.danger).
 *   - distance ≤ 100m → "Llegaste al {target}" (state.success).
 *   - 100 < distance ≤ 500m → bypass-range hint (state.warning).
 *   - distance > 500m → neutral text (text.tertiary on map.bg.surface).
 *
 * v2 tokenization: 3 ad-hoc colors (#10B981 / #F59E0B / #9CA3AF) + their
 * 12% rgba container backgrounds collapse onto the semantic state
 * tokens. The danger-tinted GPS-unavailable case uses the same family.
 */
import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { haversineDistance } from '@tricigo/utils';
import { midnightEmber } from '@tricigo/theme';

export type LiveDistanceTarget = 'pickup' | 'dropoff';

interface LiveDistanceHintProps {
  driverLocation: { latitude: number; longitude: number } | null;
  target: { latitude: number; longitude: number } | null;
  /** Which side of the trip is the target — drives the localized label. */
  targetType: LiveDistanceTarget;
}

/** Append `1F` (≈12% alpha) to a hex color so it reads as a tint. */
function tinted(color: string): string {
  return `${color}1F`;
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
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 8,
          marginBottom: 8,
          borderRadius: 8,
          backgroundColor: tinted(midnightEmber.state.danger),
          borderWidth: 1,
          borderColor: `${midnightEmber.state.danger}4D`, // ~30%
        }}
      >
        <Ionicons name="warning" size={14} color={midnightEmber.state.danger} />
        <Text
          variant="caption"
          style={{ color: midnightEmber.state.danger, marginLeft: 6, fontWeight: '600' }}
        >
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

  // Single semantic resolution: success → close, warning → bypass-range,
  // tertiary text on map surface → far-away neutral.
  const fg = isClose
    ? midnightEmber.state.success
    : isInBypassRange
      ? midnightEmber.state.warning
      : midnightEmber.map.text.tertiary;
  const bg = isClose
    ? tinted(midnightEmber.state.success)
    : isInBypassRange
      ? tinted(midnightEmber.state.warning)
      : midnightEmber.map.bg.surface;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 6,
        paddingHorizontal: 10,
        marginBottom: 8,
        borderRadius: 8,
        backgroundColor: bg,
      }}
    >
      <Ionicons
        name={isClose ? 'checkmark-circle' : 'location'}
        size={14}
        color={fg}
      />
      <Text
        variant="caption"
        style={{
          marginLeft: 6,
          color: fg,
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
