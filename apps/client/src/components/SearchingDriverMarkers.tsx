// ============================================================
// TriciGo — SearchingDriverMarkers
// Renders animated avatar markers for drivers reviewing the
// ride request on the native Mapbox map.
// ============================================================

import React, { useEffect, useRef } from 'react';
import { View, Image, Animated, StyleSheet } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { getInitials, formatRating } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import type { SearchingDriverPresence } from '@tricigo/types';
import { getMapFallbackCoordLngLat } from '@/config/demo';

let _MapboxGL: any = undefined;
function getMapboxGL(): any {
  if (_MapboxGL !== undefined) return _MapboxGL;
  try { _MapboxGL = require('@rnmapbox/maps').default; } catch { _MapboxGL = null; }
  return _MapboxGL;
}

interface SearchingDriverMarkersProps {
  drivers: SearchingDriverPresence[];
  acceptedDriverId: string | null;
}

// Map fallback; Havana in prod, configurable for demo (see config/demo.ts).
const FALLBACK_CENTER: [number, number] = getMapFallbackCoordLngLat();

/** Convert GeoPoint to Mapbox [lng, lat] with validation */
function toCoord(p: { latitude: number; longitude: number }): [number, number] {
  const lng = Number.isFinite(p?.longitude) ? p.longitude : FALLBACK_CENTER[0];
  const lat = Number.isFinite(p?.latitude) ? p.latitude : FALLBACK_CENTER[1];
  return [lng, lat];
}

/** Individual driver marker with entry/exit animations */
function DriverMarker({
  driver,
  isAccepted,
  index,
  hasAcceptedDriver,
}: {
  driver: SearchingDriverPresence;
  isAccepted: boolean;
  index: number;
  hasAcceptedDriver: boolean;
}) {
  const MapboxGL = getMapboxGL();
  const { t } = useTranslation('rider');
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.5)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const exitRan = useRef(false);

  useEffect(() => {
    // Staggered entry animation: fade-in + scale-up with index-based delay
    const entryDelay = index * 80;
    const timer = setTimeout(() => {
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
    }, entryDelay);

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

    return () => {
      clearTimeout(timer);
      pulse.stop();
    };
  }, [fadeAnim, scaleAnim, pulseAnim, index]);

  // Exit/highlight animation when a driver is accepted
  useEffect(() => {
    if (!hasAcceptedDriver || exitRan.current) return;
    exitRan.current = true;

    if (isAccepted) {
      // Accepted driver: highlight pulse — scale to 1.2 then spring back to 1
      Animated.sequence([
        Animated.spring(scaleAnim, {
          toValue: 1.2,
          damping: 12,
          stiffness: 250,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          damping: 20,
          stiffness: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      // Non-accepted drivers: fade out + scale down
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 0.3,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [hasAcceptedDriver, isAccepted, fadeAnim, scaleAnim]);

  if (!MapboxGL) return null;

  const coordinate = toCoord(driver.location);
  if (!Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
    return null;
  }

  const borderColor = isAccepted ? colors.success.DEFAULT : colors.brand.orange;

  return (
    <MapboxGL.PointAnnotation
      id={`searching-driver-${driver.driverId}`}
      coordinate={coordinate}
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
            {formatRating(driver.rating, t('rating_new', { ns: 'common', defaultValue: 'Nuevo' }))}
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
  const MapboxGL = getMapboxGL();
  if (!MapboxGL || drivers.length === 0) return null;

  return (
    <>
      {drivers.map((driver, index) => (
        <DriverMarker
          key={driver.driverId}
          driver={driver}
          index={index}
          isAccepted={driver.driverId === acceptedDriverId}
          hasAcceptedDriver={acceptedDriverId !== null}
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
