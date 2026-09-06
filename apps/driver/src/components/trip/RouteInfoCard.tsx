/**
 * RouteInfoCard — Midnight Ember edition (PR-B).
 *
 * Two distinct presentations of pickup → waypoints → dropoff:
 *   - status === 'in_progress': show only the next target inline; the
 *     rest is behind a "Ver ruta completa" toggle.
 *   - other statuses: show the full collapsed summary (1 line per stop)
 *     with addresses ellipsized; tap expands into the full card.
 *
 * v2 tokenization:
 *   - `<Card forceDark>` + `bg-[#1a1a2e]` legacy → raw `<View>` with
 *     `map.bg.elevated` background and `radius.card`.
 *   - Pickup dot: `accent[500]` (was `bg-primary-500`).
 *   - Dropoff dot: `text.tertiary` (was `bg-neutral-400`).
 *   - Waypoint dots: `state.success` (departed) / `state.warning`
 *     (arrived) / `accent[400]` (pending) — semantic family preserved.
 *   - Inline "next leg" pin icon: `accent[500]`.
 *   - Captions / addresses use `map.text.tertiary` and
 *     `map.text.primary`.
 */
import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';

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
  /** 00578: rider notes for the driver at each endpoint. */
  pickupNotes?: string | null;
  dropoffNotes?: string | null;
}

function Dot({ color, size = 12 }: { color: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
      }}
    />
  );
}

export function RouteInfoCard({
  status,
  pickupAddress,
  dropoffAddress,
  pickupNotes,
  dropoffNotes,
  waypoints,
  nextLegAddress,
}: RouteInfoCardProps) {
  const { t } = useTranslation('driver');
  const [expanded, setExpanded] = useState(false);

  const expandedCardStyle = {
    backgroundColor: midnightEmber.map.bg.elevated,
    borderColor: midnightEmber.map.line.hairline,
    borderTopColor: midnightEmber.map.line.strong,
    borderWidth: 1,
    borderRadius: midnightEmber.radius.sheet,
    padding: 14,
    marginTop: 8,
    marginBottom: 16,
  };

  const collapsedCardStyle = {
    backgroundColor: midnightEmber.map.bg.elevated,
    borderColor: midnightEmber.map.line.hairline,
    borderTopColor: midnightEmber.map.line.strong,
    borderWidth: 1,
    borderRadius: midnightEmber.radius.sheet,
    padding: 14,
    marginBottom: 16,
  };

  const dotPickup = midnightEmber.accent[500];
  const dotDropoff = midnightEmber.map.text.tertiary;
  const colorWaypoint = (wp: RouteWaypoint) =>
    wp.departed_at
      ? midnightEmber.state.success
      : wp.arrived_at
        ? midnightEmber.state.warning
        : midnightEmber.accent[400];

  // ── In-progress: show only the next target + a toggle to expand ──
  if (status === 'in_progress') {
    return (
      <>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 8 }}>
          <Ionicons name="location" size={16} color={midnightEmber.accent[500]} />
          <Text
            variant="body"
            style={{ marginLeft: 8, flex: 1, color: midnightEmber.map.text.primary }}
            numberOfLines={1}
          >
            {nextLegAddress ?? dropoffAddress}
          </Text>
        </View>
        <Pressable
          onPress={() => setExpanded(!expanded)}
          style={{ minHeight: 48, justifyContent: 'center' }}
          accessibilityRole="button"
          accessibilityLabel={expanded ? t('trip.hide_route') : t('trip.view_full_route')}
        >
          <Text
            variant="caption"
            style={{ textAlign: 'center', color: midnightEmber.accent[500] }}
          >
            {expanded ? t('trip.hide_route') : t('trip.view_full_route')}
          </Text>
        </Pressable>
        {expanded && (
          <View style={expandedCardStyle}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 }}>
              <View style={{ marginTop: 4, marginRight: 12 }}>
                <Dot color={dotPickup} />
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  variant="caption"
                  style={{ color: midnightEmber.map.text.tertiary }}
                >
                  {t('trip.pickup_address')}
                </Text>
                <Text
                  variant="bodySmall"
                  style={{ color: midnightEmber.map.text.primary }}
                >
                  {pickupAddress}
                </Text>
                {pickupNotes ? (
                  <Text variant="caption" style={{ color: midnightEmber.state.warning, marginTop: 2 }}>
                    {t('trip.rider_note', { defaultValue: 'Nota del pasajero' })}: {pickupNotes}
                  </Text>
                ) : null}
              </View>
            </View>
            {waypoints.map((wp) => (
              <View
                key={wp.id}
                style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 }}
              >
                <View style={{ marginTop: 4, marginRight: 12, marginLeft: 1 }}>
                  <Dot color={colorWaypoint(wp)} size={10} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text
                      variant="caption"
                      style={{ color: midnightEmber.accent[400] }}
                    >
                      {t('trip.waypoint_n', { n: wp.sort_order, defaultValue: `Parada ${wp.sort_order}` })}
                    </Text>
                    {wp.departed_at && (
                      <Text variant="caption" style={{ color: midnightEmber.map.text.tertiary }}>
                        ✅
                      </Text>
                    )}
                    {wp.arrived_at && !wp.departed_at && (
                      <Text variant="caption" style={{ color: midnightEmber.map.text.tertiary }}>
                        📍
                      </Text>
                    )}
                  </View>
                  <Text
                    variant="bodySmall"
                    style={{ color: midnightEmber.map.text.primary }}
                  >
                    {wp.address}
                  </Text>
                </View>
              </View>
            ))}
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              <View style={{ marginTop: 4, marginRight: 12 }}>
                <Dot color={dotDropoff} />
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  variant="caption"
                  style={{ color: midnightEmber.map.text.tertiary }}
                >
                  {t('trip.dropoff_address')}
                </Text>
                <Text
                  variant="bodySmall"
                  style={{ color: midnightEmber.map.text.primary }}
                >
                  {dropoffAddress}
                </Text>
                {dropoffNotes ? (
                  <Text variant="caption" style={{ color: midnightEmber.state.warning, marginTop: 2 }}>
                    {t('trip.rider_note', { defaultValue: 'Nota del pasajero' })}: {dropoffNotes}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>
        )}
      </>
    );
  }

  // ── Other statuses: collapsed 1-line summary; tap expands ──
  return (
    <Pressable onPress={() => setExpanded(true)}>
      <View style={collapsedCardStyle}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
          <View style={{ marginRight: 8 }}>
            <Dot color={dotPickup} size={10} />
          </View>
          <Text
            variant="caption"
            style={{ color: midnightEmber.map.text.tertiary, marginRight: 8 }}
          >
            {t('trip.pickup_address')}
          </Text>
          <Text
            variant="bodySmall"
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{ flex: 1, color: midnightEmber.map.text.primary }}
          >
            {pickupAddress}
          </Text>
        </View>
        {waypoints.length > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <View style={{ marginRight: 8 }}>
              <Dot
                color={
                  waypoints.find((w) => !w.departed_at)
                    ? midnightEmber.state.warning
                    : midnightEmber.state.success
                }
                size={10}
              />
            </View>
            <Text
              variant="caption"
              style={{ color: midnightEmber.accent[400], marginRight: 8 }}
            >
              {t('trip.stops_count', { count: waypoints.length, defaultValue: `${waypoints.length} parada(s)` })}
            </Text>
          </View>
        )}
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ marginRight: 8 }}>
            <Dot color={dotDropoff} size={10} />
          </View>
          <Text
            variant="caption"
            style={{ color: midnightEmber.map.text.tertiary, marginRight: 8 }}
          >
            {t('trip.dropoff_address')}
          </Text>
          <Text
            variant="bodySmall"
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{ flex: 1, color: midnightEmber.map.text.primary }}
          >
            {dropoffAddress}
          </Text>
        </View>
        <Text
          variant="caption"
          style={{
            textAlign: 'center',
            marginTop: 8,
            color: midnightEmber.accent[500],
            opacity: 0.85,
          }}
        >
          {t('trip.tap_to_expand', { defaultValue: 'Toca para ver direcciones completas' })}
        </Text>
      </View>
    </Pressable>
  );
}
