/**
 * RouteInfoCard — extracted from DriverTripView for PR-A.
 *
 * Two distinct presentations of pickup → waypoints → dropoff:
 *   - status === 'in_progress': show only the next target inline; the
 *     rest is behind a "Ver ruta completa" toggle.
 *   - other statuses: show the full collapsed summary (1 line per stop)
 *     with addresses ellipsized; tap expands into the full card.
 *
 * BUG-237: the collapsed summary intentionally truncates so the driver
 * doesn't try to read full addresses while driving — Maps already shows
 * turn-by-turn. The toggle is opt-in.
 *
 * State (`expanded`) lives inside the component since it's purely local.
 * Behavior + visuals preserved verbatim from the inline version.
 */
import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';

export interface RouteWaypoint {
  id: string;
  address: string;
  sort_order: number;
  arrived_at?: string | null;
  departed_at?: string | null;
}

interface RouteInfoCardProps {
  status: string;
  pickupAddress: string;
  dropoffAddress: string;
  waypoints: RouteWaypoint[];
  /** During in_progress, the address of the next leg (waypoint or dropoff). */
  nextLegAddress: string | null;
}

export function RouteInfoCard({
  status,
  pickupAddress,
  dropoffAddress,
  waypoints,
  nextLegAddress,
}: RouteInfoCardProps) {
  const { t } = useTranslation('driver');
  const [expanded, setExpanded] = useState(false);

  // ── In-progress: show only the next target + a toggle to expand ──
  if (status === 'in_progress') {
    return (
      <>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 8 }}>
          <Ionicons name="location" size={16} color="#FF4D00" />
          <Text variant="body" color="primary" style={{ marginLeft: 8, flex: 1 }} numberOfLines={1}>
            {nextLegAddress ?? dropoffAddress}
          </Text>
        </View>
        <Pressable
          onPress={() => setExpanded(!expanded)}
          style={{ minHeight: 48, justifyContent: 'center' }}
          accessibilityRole="button"
          accessibilityLabel={expanded ? t('trip.hide_route') : t('trip.view_full_route')}
        >
          <Text variant="caption" color="accent" style={{ textAlign: 'center' }}>
            {expanded ? t('trip.hide_route') : t('trip.view_full_route')}
          </Text>
        </Pressable>
        {expanded && (
          <Card forceDark variant="filled" padding="md" className="bg-[#1a1a2e] mb-4 mt-2 rounded-2xl border border-white/[0.06]">
            <View className="flex-row items-start mb-3">
              <View className="w-3 h-3 rounded-full bg-primary-500 mt-1 mr-3" />
              <View className="flex-1">
                <Text variant="caption" color="inverse" className="opacity-50">
                  {t('trip.pickup_address')}
                </Text>
                <Text variant="bodySmall" color="inverse">
                  {pickupAddress}
                </Text>
              </View>
            </View>
            {waypoints.map((wp) => (
              <View key={wp.id} className="flex-row items-start mb-3">
                <View className={`w-2.5 h-2.5 rounded-full mt-1 mr-3 ml-[1px] ${wp.departed_at ? 'bg-success' : wp.arrived_at ? 'bg-warning' : 'bg-primary-400'}`} />
                <View className="flex-1">
                  <View className="flex-row items-center gap-2">
                    <Text variant="caption" color="accent" className="opacity-70">
                      {t('trip.waypoint_n', { n: wp.sort_order, defaultValue: `Parada ${wp.sort_order}` })}
                    </Text>
                    {wp.departed_at && (
                      <Text variant="caption" color="inverse" className="opacity-40">✅</Text>
                    )}
                    {wp.arrived_at && !wp.departed_at && (
                      <Text variant="caption" color="inverse" className="opacity-40">📍</Text>
                    )}
                  </View>
                  <Text variant="bodySmall" color="inverse">
                    {wp.address}
                  </Text>
                </View>
              </View>
            ))}
            <View className="flex-row items-start">
              <View className="w-3 h-3 rounded-full bg-neutral-400 mt-1 mr-3" />
              <View className="flex-1">
                <Text variant="caption" color="inverse" className="opacity-50">
                  {t('trip.dropoff_address')}
                </Text>
                <Text variant="bodySmall" color="inverse">
                  {dropoffAddress}
                </Text>
              </View>
            </View>
          </Card>
        )}
      </>
    );
  }

  // ── Other statuses: collapsed 1-line summary; tap expands ──
  return (
    <Pressable onPress={() => setExpanded(true)}>
      <Card forceDark variant="filled" padding="md" className="bg-[#1a1a2e] mb-4 rounded-2xl border border-white/[0.06]">
        <View className="flex-row items-center mb-2">
          <View className="w-2.5 h-2.5 rounded-full bg-primary-500 mr-2" />
          <Text variant="caption" color="inverse" className="opacity-50 mr-2">
            {t('trip.pickup_address')}
          </Text>
          <Text variant="bodySmall" color="inverse" numberOfLines={1} ellipsizeMode="tail" style={{ flex: 1 }}>
            {pickupAddress}
          </Text>
        </View>
        {waypoints.length > 0 && (
          <View className="flex-row items-center mb-2">
            <View className={`w-2.5 h-2.5 rounded-full mr-2 ${waypoints.find((w) => !w.departed_at) ? 'bg-warning' : 'bg-success'}`} />
            <Text variant="caption" color="accent" className="opacity-70 mr-2">
              {t('trip.stops_count', { count: waypoints.length, defaultValue: `${waypoints.length} parada(s)` })}
            </Text>
          </View>
        )}
        <View className="flex-row items-center">
          <View className="w-2.5 h-2.5 rounded-full bg-neutral-400 mr-2" />
          <Text variant="caption" color="inverse" className="opacity-50 mr-2">
            {t('trip.dropoff_address')}
          </Text>
          <Text variant="bodySmall" color="inverse" numberOfLines={1} ellipsizeMode="tail" style={{ flex: 1 }}>
            {dropoffAddress}
          </Text>
        </View>
        <Text variant="caption" color="accent" style={{ textAlign: 'center', marginTop: 8, opacity: 0.7 }}>
          {t('trip.tap_to_expand', { defaultValue: 'Tocá para ver direcciones completas' })}
        </Text>
      </Card>
    </Pressable>
  );
}
