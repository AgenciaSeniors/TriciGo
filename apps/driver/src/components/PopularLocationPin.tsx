/**
 * PopularLocationPin — static map marker for the
 * `popular_locations` overlay (Phase 2 N5).
 *
 * Visually different from `HotspotPulseMarker`:
 *   - No animation (these clusters are 90-day historical aggregates;
 *     the pulse would imply live movement that isn't there).
 *   - Pin shape with an inner glyph (down-arrow for pickup, up-arrow
 *     for dropoff) so the driver can tell at a glance whether the
 *     cluster is "where trips usually start" vs "where trips usually
 *     end".
 *   - Smaller footprint (32×32 vs 60×60) so multiple pins can sit on
 *     the same screen without dominating the map.
 *
 * The optional `count` is shown as a tiny chip on the bottom-right
 * corner — useful for the driver to compare cluster sizes ("this one
 * has 50 historical rides, that one has 8").
 */
import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { midnightEmber } from '@tricigo/theme';

interface Props {
  /** 'pickup' | 'dropoff' — drives the inner glyph + accent shade. */
  type: 'pickup' | 'dropoff';
  /** Total ride count clustered at this location (last 90 days). */
  count?: number;
}

export function PopularLocationPin({ type, count }: Props) {
  const isPickup = type === 'pickup';
  // Pickup pins use the brand accent (these are the "where I should
  // wait" moments). Dropoff pins use a desaturated accent so they
  // visually defer to pickups, since drivers care more about pickup
  // clusters operationally.
  const fillColor = isPickup
    ? midnightEmber.accent[500]
    : midnightEmber.accent[700];
  const glyph: keyof typeof Ionicons.glyphMap = isPickup
    ? 'arrow-down'
    : 'arrow-up';

  return (
    <View
      style={{
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          backgroundColor: fillColor,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 2,
          borderColor: midnightEmber.map.text.primary,
          shadowColor: '#000',
          shadowOpacity: 0.35,
          shadowRadius: 4,
          shadowOffset: { width: 0, height: 2 },
          elevation: 3,
        }}
      >
        <Ionicons
          name={glyph}
          size={14}
          color={midnightEmber.map.text.primary}
        />
      </View>
      {count !== undefined && count >= 10 && (
        <View
          style={{
            position: 'absolute',
            bottom: -2,
            right: -4,
            paddingHorizontal: 4,
            paddingVertical: 1,
            borderRadius: 6,
            backgroundColor: midnightEmber.map.bg.canvas,
            borderWidth: 1,
            borderColor: fillColor,
            minWidth: 16,
            alignItems: 'center',
          }}
        >
          <Text
            variant="caption"
            style={{
              color: midnightEmber.map.text.primary,
              fontSize: 9,
              fontWeight: '700',
            }}
          >
            {count > 99 ? '99+' : count}
          </Text>
        </View>
      )}
    </View>
  );
}
