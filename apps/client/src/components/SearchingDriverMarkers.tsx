// ============================================================
// TriciGo — SearchingDriverMarkers
// Renders animated avatar markers for drivers reviewing the
// ride request on the native Mapbox map.
// ============================================================

import React, { useEffect, useRef } from 'react';
import { View, Image, Animated, StyleSheet } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { getInitials } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import type { SearchingDriverPresence } from '@tricigo/types';

let MapboxGL: any;
try {
  MapboxGL = require('@rnmapbox/maps').default;
} catch {
  MapboxGL = null;
}

interface SearchingDriverMarkersProps {
  drivers: SearchingDriverPresence[];
  acceptedDriverId: string | null;
}

/** Convert GeoPoint to Mapbox [lng, lat] */
function toCoord(p: { latitude: number; longitude: number }): [number, number] {
  return [p.longitude, p.latitude];
}

/** Individual driver marker with entry animation */
function DriverMarker({
  driver,
  isAccepted,
}: {
  driver: SearchingDriverPresence;
  isAccepted: boolean;
}) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.5)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // Entry animation: fade-in + scale-up
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 6,
        tension: 80,
        useNativeDriver: true,
      }),
    ]).start();

    // Pulsing border animation
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
          duration: 1200,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1200,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();

    return () => pulse.stop();
  }, [fadeAnim, scaleAnim, pulseAnim]);

  if (!MapboxGL) return null;

  const borderColor = isAccepted ? colors.success.DEFAULT : colors.brand.orange;

  return (
    <MapboxGL.PointAnnotation
      id={`searching-driver-${driver.driverId}`}
      coordinate={toCoord(driver.location)}
    >
      <Animated.View
        style={{
          opacity: fadeAnim,
          transform: [{ scale: Animated.multiply(scaleAnim, pulseAnim) }],
        }}
      >
        <View style={[styles.markerContainer, { borderColor }]}>
          {driver.avatarUrl ? (
            <Image
              source={{ uri: driver.avatarUrl }}
              style={styles.avatar}
            />
          ) : (
            <View style={styles.initialsContainer}>
              <Text style={styles.initials}>{getInitials(driver.name)}</Text>
            </View>
          )}
        </View>
        {/* Small rating badge below */}
        <View style={styles.ratingBadge}>
          <Text style={styles.ratingText}>
            {driver.rating.toFixed(1)}
          </Text>
        </View>
      </Animated.View>
    </MapboxGL.PointAnnotation>
  );
}

export function SearchingDriverMarkers({
  drivers,
  acceptedDriverId,
}: SearchingDriverMarkersProps) {
  if (!MapboxGL || drivers.length === 0) return null;

  return (
    <>
      {drivers.map((driver) => (
        <DriverMarker
          key={driver.driverId}
          driver={driver}
          isAccepted={driver.driverId === acceptedDriverId}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  markerContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2.5,
    overflow: 'hidden',
    backgroundColor: colors.neutral[800],
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  avatar: {
    width: 31,
    height: 31,
    borderRadius: 16,
  },
  initialsContainer: {
    width: 31,
    height: 31,
    borderRadius: 16,
    backgroundColor: colors.brand.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  ratingBadge: {
    position: 'absolute',
    bottom: -6,
    alignSelf: 'center',
    backgroundColor: colors.neutral[900],
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.neutral[700],
  },
  ratingText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '600',
  },
});
